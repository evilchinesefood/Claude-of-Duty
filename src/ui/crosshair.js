import { el, setStyle, clamp, clamp01, damp, ease } from './util.js';

/**
 * Dynamic four-blade reticle.
 *
 * Spread model (all in HUD pixels at k=1):
 *   gap = base + move*MOVE + fire kick + flinch
 * The kick is a spring so a burst punches the blades out and they settle back
 * with a little overshoot instead of linearly interpolating — that overshoot is
 * most of what makes firing feel mechanical rather than animated.
 *
 * ADS hides the whole reticle over 70ms (the optic reticle is the weapon's job).
 */
export class Crosshair {
  constructor(parent) {
    this.root = el('div', 'ow-cross', parent);
    this.blades = new Array(4);
    for (let i = 0; i < 4; i++) this.blades[i] = el('div', 'ow-blade', this.root);
    this.dot = el('div', 'ow-dot', this.root);

    this.k = 1;
    this.gap = 6;
    this.kick = 0;
    this.kickVel = 0;
    this.moveSpread = 0;
    this.adsBlend = 0;
    this.hitPulse = 0;
    this.visible = 1;

    // preallocated transform scratch — string concat only, no objects
    this._rot = [0, 90, 180, 270];

    // Last emitted strings plus the quantised integers they were built from.
    // gap/len/opacity are all damped, so they converge and then sit still;
    // rebuilding only when the quantised value moves makes the steady state
    // allocation-free instead of ~20 strings/frame. NaN forces the first build.
    this._xf = ['', '', '', ''];
    this._bladeOpacity = '';
    this._dotXf = '';
    this._dotOpacity = '';
    this._qGap = NaN;
    this._qLen = NaN;
    this._qBladeOpacity = NaN;
    this._qDotScale = NaN;
    this._qDotOpacity = NaN;
  }

  /** Called on every shot. `amount` scales with weapon recoil. */
  onFire(amount = 1) {
    this.kickVel += 78 * amount;
    this.kick = Math.min(this.kick + 1.2 * amount, 16);
  }

  /** Taking damage nudges the reticle — reads as flinch. */
  onFlinch(amount = 1) {
    this.kickVel += 30 * amount;
  }

  onHit() {
    this.hitPulse = 1;
  }

  /**
   * @param {object} s { move:0..1, sprint:bool, ads:bool, crouch:bool,
   *                     baseSpread:px, hidden:bool }
   */
  update(dt, s) {
    // --- spring kick -------------------------------------------------------
    const stiff = 150;
    const dampC = 15;
    this.kickVel += (0 - this.kick) * stiff * dt - this.kickVel * dampC * dt;
    this.kick += this.kickVel * dt;
    if (this.kick < 0) {
      this.kick = 0;
      if (this.kickVel < 0) this.kickVel *= 0.4;
    }

    // --- movement / stance bloom ------------------------------------------
    const target =
      (s.move ?? 0) * 7 + (s.sprint ? 6 : 0) - (s.crouch ? 1.6 : 0) + (s.airborne ? 5 : 0);
    this.moveSpread = damp(this.moveSpread, target, 9, dt);

    this.adsBlend = damp(this.adsBlend, s.ads ? 1 : 0, 16, dt);
    this.hitPulse = Math.max(0, this.hitPulse - dt * 5.5);

    const base = (s.baseSpread ?? 5.5) - this.adsBlend * 2;
    const gap = (base + this.moveSpread + this.kick) * this.k;
    // blades grow a touch as they spread — keeps the mass of the reticle even
    const len = clamp(1 + this.moveSpread * 0.035 + this.kick * 0.05, 1, 1.7);

    const fade = clamp01(1 - this.adsBlend * 1.25) * (s.hidden ? 0 : 1);
    this.visible = damp(this.visible, fade, 22, dt);
    const vis = this.visible;

    const bright = 1 - 0.25 * this.adsBlend + 0.5 * ease.outQuad(this.hitPulse);

    // Quantise to exactly the precision the format emits, then build the string
    // back out of that integer — guard and output stay in 1:1 correspondence, so
    // a value that only jitters below the printed digit can never emit a
    // different transform. Math.round, not `| 0`: truncation disagrees with
    // toFixed at a boundary and would shift the reticle by a printed digit.
    const qGap = Math.round(gap * 100);
    const qLen = Math.round(len * 1000);
    if (qGap !== this._qGap || qLen !== this._qLen) {
      this._qGap = qGap;
      this._qLen = qLen;
      const g = (qGap / 100).toFixed(2);
      const l = (qLen / 1000).toFixed(3);
      const tail = `deg) translateY(${-g}px) scaleY(${l})`;
      for (let i = 0; i < 4; i++) this._xf[i] = 'rotate(' + this._rot[i] + tail;
    }
    const qBladeOpacity = Math.round(vis * Math.min(1, bright) * 1000);
    if (qBladeOpacity !== this._qBladeOpacity) {
      this._qBladeOpacity = qBladeOpacity;
      this._bladeOpacity = (qBladeOpacity / 1000).toFixed(3);
    }
    for (let i = 0; i < 4; i++) {
      const b = this.blades[i];
      setStyle(b, 'transform', this._xf[i]);
      setStyle(b, 'opacity', this._bladeOpacity);
    }

    const qDotScale = Math.round((1 + this.hitPulse * 1.1) * 1000);
    if (qDotScale !== this._qDotScale) {
      this._qDotScale = qDotScale;
      this._dotXf = `scale(${(qDotScale / 1000).toFixed(3)})`;
    }
    setStyle(this.dot, 'transform', this._dotXf);
    const qDotOpacity = Math.round(vis * (0.85 + 0.15 * this.hitPulse) * 1000);
    if (qDotOpacity !== this._qDotOpacity) {
      this._qDotOpacity = qDotOpacity;
      this._dotOpacity = (qDotOpacity / 1000).toFixed(3);
    }
    setStyle(this.dot, 'opacity', this._dotOpacity);
    setStyle(this.root, 'display', vis < 0.004 ? 'none' : '');
  }

  setScale(k) {
    this.k = k;
  }

  dispose() {
    this.root.remove();
  }
}
