/**
 * Input aggregation: keyboard, mouse (pointer-locked), and gamepad, exposed as
 * a stable per-frame snapshot so gameplay never touches raw DOM events.
 *
 * Edge queries (`pressed`, `released`) are valid only during the frame in which
 * the transition happened — read them in update(), not fixedUpdate().
 */

export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  swapWeapon: ['Digit1', 'Digit2', 'Tab'],
  grenade: ['KeyG'],
  flashlight: ['KeyT'],
  pause: ['Escape'],
};

export class Input {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;

    this.down = new Set(); // codes currently held
    this._pressed = new Set(); // went down this frame
    this._released = new Set(); // went up this frame

    /**
     * Raw DOM transitions in ARRIVAL ORDER, replayed by beginFrame().
     *
     * This must be a queue, not a down-Set plus an up-Set: a release and a
     * re-press of the same code both land inside a single frame gap on any
     * double-tap (tac-sprint, W tapped while held). Draining "all downs, then
     * all ups" applies them in the wrong order — the down is swallowed as a
     * no-op because the code is still held, then the up clears it — and since
     * `_onKeyDown` filters autorepeat, nothing ever presses the key again. The
     * key stays marked up while it is physically held, permanently.
     *
     * Records are preallocated and reused; the array only grows on a frame that
     * sees more transitions than any before it, so steady state allocates
     * nothing (R5).
     */
    this._queue = [];
    this._queueLen = 0;
    for (let i = 0; i < 64; i++) this._queue.push({ code: '', down: false });

    // tools/demo-driver.js synthesises input by calling `_pendingDown.add(code)`
    // / `_pendingUp.add(code)`. Those Sets are gone; keep the `.add` shape so the
    // capture harness keeps working, routed through the ordered queue.
    this._pendingDown = { add: (code) => this._queueEvent(code, true) };
    this._pendingUp = { add: (code) => this._queueEvent(code, false) };

    /** Accumulated pointer delta for this frame, in radians after sensitivity. */
    this.look = { x: 0, y: 0 };
    this._rawLook = { x: 0, y: 0 };
    this.wheel = 0;
    this._pendingWheel = 0;

    this.pointerLocked = false;
    this.enabled = true;
    /** Set true by capture mode so scripted shots aren't fought by real input. */
    this.frozen = false;

    this.gamepadIndex = null;
    this.stick = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };

    this._bound = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      mousedown: this._onMouseDown.bind(this),
      mouseup: this._onMouseUp.bind(this),
      mousemove: this._onMouseMove.bind(this),
      wheel: this._onWheel.bind(this),
      lockchange: this._onLockChange.bind(this),
      blur: this._onBlur.bind(this),
      contextmenu: (e) => e.preventDefault(),
    };
  }

  attach() {
    addEventListener('keydown', this._bound.keydown);
    addEventListener('keyup', this._bound.keyup);
    addEventListener('mousedown', this._bound.mousedown);
    addEventListener('mouseup', this._bound.mouseup);
    addEventListener('mousemove', this._bound.mousemove);
    addEventListener('wheel', this._bound.wheel, { passive: true });
    addEventListener('blur', this._bound.blur);
    document.addEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.addEventListener('contextmenu', this._bound.contextmenu);
  }

  detach() {
    removeEventListener('keydown', this._bound.keydown);
    removeEventListener('keyup', this._bound.keyup);
    removeEventListener('mousedown', this._bound.mousedown);
    removeEventListener('mouseup', this._bound.mouseup);
    removeEventListener('mousemove', this._bound.mousemove);
    removeEventListener('wheel', this._bound.wheel);
    removeEventListener('blur', this._bound.blur);
    document.removeEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.removeEventListener('contextmenu', this._bound.contextmenu);
  }

  requestPointerLock() {
    // Chrome returns a promise that rejects if the document is not eligible
    // (headless capture, an iframe, a lock request too soon after an exit).
    // An unhandled rejection there shows up as a page error in the harness, so
    // swallow it: failing to lock is not a game error.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not eligible — keep running unlocked */
    }
  }

  /** Append one transition to the ordered queue, reusing a preallocated record. */
  _queueEvent(code, down) {
    // A queue this deep means nothing is draining it — the whole pre-warm accepts
    // input before the first beginFrame(). Drop the overflow rather than growing
    // the backing array for the session; blur/beginFrame reconcile the state.
    if (this._queueLen >= 4096) return;
    if (this._queueLen === this._queue.length) this._queue.push({ code: '', down: false });
    const rec = this._queue[this._queueLen++];
    rec.code = code;
    rec.down = down;
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    if (e.repeat) return;
    // Let devtools/refresh through; swallow everything else the game binds.
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    this._queueEvent(e.code, true);
  }

  _onKeyUp(e) {
    if (!this.enabled) return;
    this._queueEvent(e.code, false);
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    if (!this.pointerLocked && e.button === 0) this.requestPointerLock();
    this._queueEvent(`Mouse${e.button}`, true);
  }

  _onMouseUp(e) {
    if (!this.enabled) return;
    this._queueEvent(`Mouse${e.button}`, false);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.pointerLocked || this.frozen) return;
    // movementX/Y is already relative and unaffected by cursor clamping.
    this._rawLook.x += e.movementX ?? 0;
    this._rawLook.y += e.movementY ?? 0;
  }

  _onWheel(e) {
    if (!this.enabled) return;
    this._pendingWheel += Math.sign(e.deltaY);
  }

  _onLockChange() {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this._onBlur();
  }

  /**
   * Losing focus must release every held key, or the player runs forever.
   * The releases go through the same queue rather than clearing state out of
   * band, so they cannot jump ahead of a press that arrived earlier in this
   * frame gap. Codes queued down but not yet applied get an up too — blur beats
   * them; a duplicate up is a no-op because `down.delete` fails the second time.
   */
  _onBlur() {
    for (const code of this.down) this._queueEvent(code, false);
    for (let i = 0, n = this._queueLen; i < n; i++) {
      if (this._queue[i].down) this._queueEvent(this._queue[i].code, false);
    }
    this._rawLook.x = 0;
    this._rawLook.y = 0;
  }

  beginFrame() {
    this._pressed.clear();
    this._released.clear();

    for (let i = 0; i < this._queueLen; i++) {
      const rec = this._queue[i];
      if (rec.down) {
        if (!this.down.has(rec.code)) {
          this.down.add(rec.code);
          this._pressed.add(rec.code);
        }
      } else if (this.down.delete(rec.code)) {
        this._released.add(rec.code);
      }
    }
    this._queueLen = 0;

    const s = this.config.sensitivity;
    this.look.x = this.frozen ? 0 : this._rawLook.x * s;
    this.look.y = this.frozen ? 0 : this._rawLook.y * s * (this.config.invertY ? -1 : 1);
    this._rawLook.x = 0;
    this._rawLook.y = 0;

    this.wheel = this._pendingWheel;
    this._pendingWheel = 0;

    this._pollGamepad();
  }

  endFrame() {}

  _pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads[this.gamepadIndex ?? 0] ?? pads.find(Boolean);
    if (!pad) {
      this.stick.moveX = this.stick.moveY = this.stick.lookX = this.stick.lookY = 0;
      return;
    }
    const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
    this.stick.moveX = dz(pad.axes[0] ?? 0);
    this.stick.moveY = dz(pad.axes[1] ?? 0);
    // Cubic response curve on the look stick — fine aim near centre, fast flicks at the edge.
    const curve = (v) => Math.sign(v) * Math.abs(v) ** 2.4;
    this.stick.lookX = curve(dz(pad.axes[2] ?? 0));
    this.stick.lookY = curve(dz(pad.axes[3] ?? 0));
  }

  /** True while any key bound to `action` is held. */
  action(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  held(code) {
    return this.down.has(code);
  }

  pressed(code) {
    return this._pressed.has(code);
  }

  released(code) {
    return this._released.has(code);
  }

  get fire() {
    return this.down.has('Mouse0');
  }

  get firePressed() {
    return this._pressed.has('Mouse0');
  }

  get ads() {
    return this.down.has('Mouse2');
  }

  /** Normalised WASD + left-stick movement, clamped to the unit disc so
   *  diagonals aren't faster than cardinals. */
  moveVector(out = { x: 0, y: 0 }) {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    x += this.stick.moveX;
    y -= this.stick.moveY;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    return out;
  }
}
