import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';
import { detectQuality, QUALITY_PRESETS } from './core/config.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';

// `ultra` is opt-in. Booting every visitor at ultra reserves ~600 MB of render
// targets before a triangle is drawn, which kills the GPU process on integrated
// graphics — the browser shows that as a tab crash, not as a catchable error.
// Capture keeps the fixed preset so the pixel gate has one reference.
//
// The override is validated against the preset table rather than used raw. An
// unrecognised `?q=` produced `cfg.q = {...undefined}` — an empty quality object
// that every subsystem then read `undefined` out of — and it reaches the DOM.
const qOverride = params.get('q');
const forced = qOverride && Object.hasOwn(QUALITY_PRESETS, qOverride) ? qOverride : null;
const quality = forced ?? (capture ? 'ultra' : detectQuality());

const config = createConfig({ quality, deterministic: capture });

const canvas = document.getElementById('game');

// ---------------------------------------------------------------------------
// Boot overlay.
//
// Boot is 4-15 s of mostly unbroken main-thread work (procedural texture bakes,
// ~1.8M triangles of level geometry, then 130+ shader programs). With nothing on
// screen that is indistinguishable from a hang, and it is the single most common
// bug report. Built before the Engine so it paints on the first frame.
// ---------------------------------------------------------------------------
const boot = capture ? null : installBootOverlay();

function installBootOverlay() {
  const root = document.createElement('div');
  root.id = 'boot';
  root.innerHTML = `
    <style>
      #boot { position: fixed; inset: 0; z-index: 100; display: grid; place-content: center;
        gap: 14px; background: #07080a; color: #c8ccd2; text-align: center;
        font: 13px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        letter-spacing: .08em; text-transform: uppercase; }
      #boot b { font-size: 22px; letter-spacing: .34em; color: #fff; font-weight: 600; }
      #boot .bar { width: min(340px, 74vw); height: 2px; background: #23262b; overflow: hidden; }
      #boot .bar i { display: block; height: 100%; width: 0; background: #d8a24a;
        transition: width .18s linear; }
      #boot .phase { color: #7d848d; min-height: 1.6em; }
      #boot .hint { color: #4d535a; font-size: 11px; letter-spacing: .06em; text-transform: none; }
      #boot .err { color: #ff6b6b; max-width: min(560px, 86vw); text-transform: none;
        text-align: left; letter-spacing: 0; white-space: pre-wrap; }
      #boot a { color: #d8a24a; }
    </style>
    <b>OVERWATCH</b>
    <div class="bar"><i></i></div>
    <div class="phase">booting</div>
    <div class="hint"></div>`;
  // `quality` is one of the four preset keys, but it originates in the query
  // string — it goes in as text, never as markup.
  root.querySelector('.hint').textContent =
    `quality: ${quality}${forced ? '' : ' (auto)'} · override with ?q=low / medium / high / ultra`;
  document.body.appendChild(root);

  const fill = root.querySelector('.bar i');
  const phase = root.querySelector('.phase');
  return {
    // Init is the long pole, so it owns 0-80% and pre-warm the last 20%.
    progress(frac, label) {
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
      if (label) phase.textContent = label;
    },
    /** @param link  Optional `{ href, text }`; href is built here, never from input. */
    fail(title, detail, link) {
      root.querySelector('.bar')?.remove();
      phase.textContent = '';
      const box = document.createElement('div');
      box.className = 'err';
      const h = document.createElement('b');
      h.style.cssText = 'font-size:13px;letter-spacing:.1em';
      h.textContent = title;
      box.append(h, document.createTextNode(`\n\n${detail}`));
      if (link) {
        const a = document.createElement('a');
        a.href = link.href;
        a.textContent = link.text;
        box.append(document.createTextNode('\n\n'), a);
      }
      phase.appendChild(box);
    },
    done() {
      root.remove();
    },
  };
}

const engine = new Engine({ canvas, config });

// A lost context is permanent unless something restores it, and three.js does
// not resurrect the scene on its own. Without this the canvas simply freezes on
// the last good frame forever, which reads as "the game crashed" with no clue.
//
// Registered after the Engine exists, not before: `engine` is a `const`, so a
// handler that closes over it and fires first would hit the temporal dead zone
// and throw ReferenceError — optional chaining does not cover TDZ. Nothing can
// lose a context before this point anyway, since the WebGL renderer is not
// created until `render.init()`.
canvas.addEventListener(
  'webglcontextlost',
  (e) => {
    e.preventDefault();
    engine.stop();
    const lower = { ultra: 'high', high: 'medium', medium: 'low' }[config.quality] ?? 'low';
    (boot ?? installBootOverlay()).fail(
      'GPU context lost',
      'The graphics driver dropped the WebGL context, usually because the GPU ran out of memory.',
      { href: `?q=${lower}`, text: `Reload at ${lower} quality →` },
    );
  },
  false,
);

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(UiSystem)
  .add(AudioSystem);

const PHASE_LABEL = {
  render: 'starting renderer',
  materials: 'baking surfaces',
  sky: 'building atmosphere',
  world: 'constructing level',
  physics: 'building collision',
  player: 'spawning',
  weapons: 'machining weapons',
  fx: 'loading effects',
  ai: 'briefing enemies',
  ui: 'drawing hud',
  audio: 'tuning audio',
};

try {
  // Init owns 0-80% of the bar; pre-warm below owns the rest.
  await engine.init((id, done, total) =>
    boot?.progress((done / total) * 0.8, PHASE_LABEL[id] ?? id),
  );
} catch (err) {
  console.error('[boot] init failed', err);
  const webgl2 = (() => {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch {
      return false;
    }
  })();
  (boot ?? installBootOverlay()).fail(
    webgl2 ? 'Boot failure' : 'WebGL2 not available',
    webgl2
      ? String(err?.stack ?? err?.message ?? err)
      : 'This browser or GPU does not expose WebGL2, which the renderer requires. Try a current Chrome, Edge or Firefox, and check that hardware acceleration is enabled.',
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// Compile every shader permutation before the frame loop starts. Measured: without
// this, 86 programs compile lazily during play, up to 30 on one frame, producing
// 3.1-3.9 SECOND stalls. See src/core/prewarm.js.
//
// ON BY DEFAULT since the capture path was made frame-deterministic; opt out with
// `?prewarm=0`. It is now PROVEN pixel-neutral: `tools/baseline.mjs` with
// `--query=prewarm=0` vs `--query=prewarm=1` reports identical:true on all 11
// shots (0 changed pixels, maxDelta 0). The two things that previously made the
// ~1.4 s pre-warm spend look like a visual change were both boot-duration
// couplings OUTSIDE the subsystems: (1) the shutter frame index was latency-bound
// because the engine kept stepping through the driver's round trips — fixed by
// lockstep in src/dev/shots.js; (2) `will-change: transform` on the compass strip
// cached a composited-layer raster taken at a wall-clock-dependent moment — fixed
// in src/ui/style.js.
//
// `onProgress` matters more than it looks: where KHR_parallel_shader_compile is
// missing (most Intel/Mesa drivers) `compileAsync` degrades to a blocking
// compile, and this step is then the longest uninterrupted block in the whole
// boot — 130+ programs with no yield. The bar is the only thing distinguishing
// it from a hang.
boot?.progress(0.8, 'compiling shaders');
const warmup =
  params.get('prewarm') === '0'
    ? { ok: false, reason: 'disabled by ?prewarm=0' }
    : await prewarm(engine, { onProgress: (f) => boot?.progress(0.8 + f * 0.2) });
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

boot?.progress(1, 'ready');
engine.start();

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      // Torn down only once a real frame is on screen, so the overlay never
      // uncovers a black canvas.
      boot?.done();
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
