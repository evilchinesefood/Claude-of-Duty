import { el, setText, setStyle, clamp01, damp, ease, metres, cardinal } from './util.js';

/**
 * Death screen.
 *
 * Raised the frame `player.getHudState().dead` goes true, torn down on the
 * respawn. The whole point of it is a state *change*: at 0 HP the low-health
 * vignette is already saturated, so anything that merely fades what was already
 * on screen reads as a stall rather than as dying. This lands a hard scrim over
 * the frame, names the attacker, and holds until the player asks to go back in.
 *
 * Every value is integrated from `dt` — game time, so it freezes with the rest
 * of the HUD when the pause menu opens over it and the capture harness stays
 * deterministic. No CSS transition or keyframe touches it.
 */
export class DeathScreen {
  constructor(parent) {
    this.root = el('div', 'ow-death', parent);
    this.scrim = el('div', 'ow-death-scrim', this.root);

    const box = el('div', 'ow-death-box', this.root);
    this.title = el('div', 'ow-death-t', box, 'YOU DIED');
    this.rule = el('div', 'ow-death-rule', box);

    this.by = el('div', 'ow-death-by', box);
    this.byLabel = el('span', 'ow-death-by-l', this.by, 'KILLED BY');
    this.byName = el('span', 'ow-death-by-n', this.by, '');
    this.byDist = el('span', 'ow-death-by-d', this.by, '');

    const foot = el('div', 'ow-death-foot', box);
    this.hold = el('div', 'ow-death-hold', foot);
    this.holdFill = el('i', null, this.hold);
    this.cue = el('div', 'ow-death-cue', foot);
    this.key = el('div', 'ow-key', this.cue, 'SPACE');
    el('span', null, this.cue, 'RESPAWN');

    this.active = false;
    this.shown = 0;
    this.t = 0;
    this._pulse = 0;
    /** Latched so the fade-out does not flip back to the hold bar. */
    this._ready = false;
    this._progress = 0;
    setStyle(this.root, 'display', 'none');
  }

  /**
   * @param {string} name      attacker, display-ready; '' when unattributable
   * @param {number} distance  metres to the attacker, negative when unknown
   * @param {number} bearing   compass degrees to the attacker
   */
  show(name, distance, bearing) {
    this.active = true;
    this.t = 0;
    this._pulse = 0;
    this._ready = false;
    this._progress = 0;
    const known = !!name;
    setStyle(this.byLabel, 'display', known ? '' : 'none');
    setText(this.byName, known ? name : 'KILLED IN ACTION');
    const located = known && distance >= 0;
    setText(this.byDist, located ? `${metres(distance)} · ${cardinal(bearing)}` : '');
    setStyle(this.byDist, 'display', located ? '' : 'none');
  }

  hide() {
    this.active = false;
  }

  /**
   * @param {number} dt        game seconds
   * @param {number} progress  0..1 of the mandatory hold elapsed
   * @param {boolean} ready    the respawn is armed and waiting on input
   */
  update(dt, progress, ready) {
    this.shown = damp(this.shown, this.active ? 1 : 0, 11, dt);
    if (!this.active && this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      return;
    }
    if (this.active) {
      this._ready = ready;
      this._progress = progress;
    }
    setStyle(this.root, 'display', '');
    this.t += dt;

    const vis = ease.outQuad(this.shown);
    setStyle(this.scrim, 'opacity', vis.toFixed(3));

    // The title lands rather than fades: a short overshoot settling to rest,
    // on its own clock so nothing downstream can restart it.
    const punch = ease.outQuint(clamp01(this.t / 0.42));
    setStyle(this.title, 'transform', `scale(${(1.11 - 0.11 * punch).toFixed(4)})`);
    setStyle(this.title, 'opacity', clamp01(this.shown * 1.25).toFixed(3));
    setStyle(this.rule, 'transform', `scaleX(${ease.outCubic(clamp01(this.t / 0.55)).toFixed(3)})`);
    setStyle(this.by, 'opacity', (clamp01((this.t - 0.26) / 0.38) * vis).toFixed(3));

    setStyle(this.hold, 'display', this._ready ? 'none' : '');
    setStyle(this.cue, 'display', this._ready ? '' : 'none');
    if (this._ready) {
      this._pulse += dt;
      // ~0.9 Hz breathe, so the prompt reads as live without a CSS keyframe.
      const a = 0.62 + 0.38 * (0.5 - 0.5 * Math.cos(this._pulse * 5.6));
      setStyle(this.cue, 'opacity', (a * vis).toFixed(3));
    } else {
      setStyle(this.holdFill, 'transform', `scaleX(${clamp01(this._progress).toFixed(3)})`);
    }
  }

  dispose() {
    this.root.remove();
  }
}
