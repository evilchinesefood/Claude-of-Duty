import * as THREE from 'three';
import { Registry, EventBus } from './registry.js';
import { FIXED_DT, MAX_SUBSTEPS } from './config.js';
import { Input } from './input.js';
import { Rng } from './rng.js';

/**
 * The Engine owns the frame loop and the shared context handed to every
 * subsystem. It does NOT know what any subsystem does — it only sequences them.
 *
 * Frame order:
 *   1. input.beginFrame()
 *   2. fixedUpdate(FIXED_DT) xN   — physics, deterministic gameplay
 *   3. update(dt)                 — animation, cameras, AI decisions
 *   4. lateUpdate(dt)             — anything that must observe final transforms
 *   5. render subsystem draws
 *   6. input.endFrame()
 */
export class Engine {
  constructor({ canvas, config }) {
    this.canvas = canvas;
    this.config = config;
    this.registry = new Registry();
    this.events = new EventBus();
    this.input = new Input(canvas, config);
    this.rng = new Rng(config.deterministic ? 0x5eed1234 : (Math.random() * 2 ** 32) >>> 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(config.fov, 1, 0.05, 1200);
    this.camera.rotation.order = 'YXZ';

    /** Separate scene+camera for the first-person viewmodel, drawn with its own
     *  near plane so hands/weapon never clip into world geometry. */
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(60, 1, 0.005, 12);

    this.time = {
      /** Seconds since start, scaled. */ elapsed: 0,
      /** Unscaled wall-clock seconds since start. */ raw: 0,
      /** Last frame delta, scaled and clamped. */ dt: 0,
      /** Fixed step. */ fixed: FIXED_DT,
      /** Interpolation alpha between the last two physics steps, 0..1. */ alpha: 0,
      scale: 1,
      frame: 0,
    };

    this.ctx = {
      engine: this,
      scene: this.scene,
      camera: this.camera,
      viewScene: this.viewScene,
      viewCamera: this.viewCamera,
      canvas,
      config,
      events: this.events,
      input: this.input,
      time: this.time,
      rng: this.rng,
      get: (id) => this.registry.get(id),
      peek: (id) => this.registry.peek(id),
      has: (id) => this.registry.has(id),
    };

    this._accum = 0;
    this._last = 0;
    this._running = false;
    this._onResize = () => this.resize();
  }

  add(SystemClass, opts) {
    this.registry.add(new SystemClass(opts));
    return this;
  }

  /**
   * @param onPhase  Called as `(id, done, total)` before each subsystem inits,
   *   so a boot overlay can name what is being built. Boot is many seconds of
   *   unbroken main-thread work (world alone is the bulk of it) and without a
   *   paint between subsystems the page is a black rectangle the whole time —
   *   which the browser is entitled to kill as unresponsive.
   */
  async init(onPhase) {
    const order = this.registry.resolve();
    // Skipped under `deterministic`: the capture harness measures boot in frames,
    // and handing frames to the browser mid-init would let the clock advance
    // between subsystems. Capture already renders to an offscreen page nobody
    // is watching, so it needs neither the paint nor the overlay.
    // rAF for a real paint, raced against a timer because a backgrounded tab
    // throttles or suspends rAF entirely — boot must still finish there.
    const yieldPaint = this.config.deterministic
      ? () => Promise.resolve()
      : () =>
          new Promise((r) => {
            let done = false;
            const fire = () => {
              if (done) return;
              done = true;
              r();
            };
            requestAnimationFrame(() => setTimeout(fire, 0));
            setTimeout(fire, 250);
          });

    for (let i = 0; i < order.length; i++) {
      const sys = order[i];
      onPhase?.(sys.constructor.id, i, order.length);
      await yieldPaint();
      const t0 = performance.now();
      await sys.init?.(this.ctx);
      const ms = performance.now() - t0;
      if (ms > 50) console.info(`[engine] ${sys.constructor.id} init ${ms.toFixed(0)}ms`);
    }
    onPhase?.('ready', order.length, order.length);
    this.input.attach();
    addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    for (const sys of this.registry.with('resize')) sys.resize(w, h, this.ctx);
    this.events.emit('resize', { width: w, height: h });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
  }

  _loop(now) {
    if (!this._running) return;
    requestAnimationFrame(this._loop);
    this.step(now);
  }

  /** Advance one frame. Exposed so the capture harness can pump frames by hand. */
  step(now = performance.now()) {
    const t = this.time;
    // Clamp so a tab-switch or a breakpoint doesn't teleport the simulation.
    // The bound is exactly what the substep budget can actually simulate
    // (MAX_SUBSTEPS x FIXED_DT = 66.7 ms): a looser clamp hands update() and
    // lateUpdate() more time than fixedUpdate() can consume, so below ~15 fps
    // the character controller advances at 67-80% of wall-clock while camera
    // springs, ADS blend, health regen and HUD timers run at 100%.
    // No effect on capture: src/dev/shots.js pins rawDt to 1/60.
    const rawDt = Math.min(MAX_SUBSTEPS * FIXED_DT, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    t.raw += rawDt;
    t.dt = rawDt * t.scale;
    t.elapsed += t.dt;
    t.frame++;

    this.input.beginFrame();

    this._accum += t.dt;
    let steps = 0;
    const fixedSystems = this.registry.with('fixedUpdate');
    while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (const sys of fixedSystems) sys.fixedUpdate(FIXED_DT, this.ctx);
      this._accum -= FIXED_DT;
      steps++;
    }
    // Shed backlog rather than spiral — but only when there IS one. `time.scale`
    // above 1 can still outrun the budget even with dt clamped. Dropping whole
    // steps with `%=` keeps the sub-step phase, where `= 0` forced alpha to 0 and
    // popped every interpolated transform back a full step; and the guard stops
    // it firing at all when the last step legitimately drained the accumulator.
    if (steps === MAX_SUBSTEPS && this._accum >= FIXED_DT) this._accum %= FIXED_DT;
    t.alpha = this._accum / FIXED_DT;

    for (const sys of this.registry.with('update')) sys.update(t.dt, this.ctx);
    for (const sys of this.registry.with('lateUpdate')) sys.lateUpdate(t.dt, this.ctx);

    const renderSystem = this.registry.peek('render');
    if (typeof renderSystem?.render === 'function') renderSystem.render(this.ctx);

    this.input.endFrame();
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.input.detach();
    for (const sys of [...this.registry.ordered].reverse()) sys.dispose?.();
    this.events.clear();
  }
}
