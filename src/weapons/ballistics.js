import * as THREE from 'three';

/**
 * Projectile ballistics.
 *
 * Rounds are simulated, not hitscanned: each shot is a body with a muzzle
 * velocity, gravity and a drag term, stepped at the physics rate. A 9 mm round
 * takes 140 ms to cross a 50 m street and drops about 10 cm doing it, and you
 * can see the tracer travel. Terminal effects (penetration, spall, damage) are
 * handed to `physics.fireBullet()` at the moment of contact so wall penetration
 * and multi-layer hits stay in one place.
 */

const GRAVITY = -9.81;
const MAX_LIVE = 96;

class Projectile {
  constructor() {
    this.alive = false;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    this.damage = 30;
    this.penetration = 1;
    this.dragK = 0.3;
    this.travelled = 0;
    this.maxRange = 400;
    this.age = 0;
    this.dropoff = 0.5;
    this.weapon = null;
    this.mask = undefined;
    this.source = null;
  }
}

export class ProjectileSim {
  constructor(ctx) {
    this.ctx = ctx;
    this.pool = [];
    for (let i = 0; i < MAX_LIVE; i++) this.pool.push(new Projectile());
    this.live = [];
    this._seg = new THREE.Vector3();
    this._hitDir = new THREE.Vector3();
    this._tracerFrom = new THREE.Vector3();
    this._tracerTo = new THREE.Vector3();
    this._tracerPayload = { from: this._tracerFrom, to: this._tracerTo, speed: 800, weapon: null };
    this.stats = { fired: 0, impacts: 0, live: 0 };
  }

  get physics() {
    if (!this._physics) this._physics = this.ctx.peek('physics');
    return this._physics;
  }

  /**
   * Attribution for rounds spawned without an explicit `source`: this sim only
   * ever carries the local player's shots (the ai fires hitscan straight at
   * `physics.fireBullet`), and `damage:dealt` needs a shooter so the HUD does
   * not credit the player for someone else's kill.
   */
  get playerSource() {
    if (!this._playerSource) this._playerSource = this.ctx.peek('player') ?? 'player';
    return this._playerSource;
  }

  /**
   * @param {object} o origin, dir (unit), speed, damage, penetration, dragK,
   *                   maxRange, dropoff, weapon, tracer, source
   */
  spawn(o) {
    let p = null;
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].alive) {
        p = this.pool[i];
        break;
      }
    }
    if (!p) {
      // Oldest round yields its slot rather than dropping the shot. It has to
      // leave `live` as well — `_retire` only clears the flag, so pushing it
      // back below would list the same projectile twice and integrate (and
      // impact) it twice per step.
      p = this.live.shift();
      if (!p) return null;
      this._retire(p);
    }
    p.alive = true;
    p.pos.copy(o.origin);
    p.prev.copy(o.origin);
    p.dir.copy(o.dir).normalize();
    p.vel.copy(p.dir).multiplyScalar(o.speed ?? 800);
    p.damage = o.damage ?? 30;
    p.penetration = o.penetration ?? 1;
    p.dragK = o.dragK ?? 0.3;
    p.dropoff = o.dropoff ?? 0.5;
    p.maxRange = o.maxRange ?? 400;
    p.travelled = 0;
    p.age = 0;
    p.weapon = o.weapon ?? null;
    p.mask = o.mask;
    p.source = o.source ?? null;
    this.live.push(p);
    this.stats.fired++;

    if (o.tracer) this._emitTracer(p, o.speed ?? 800);
    return p;
  }

  /** One tracer per burst of rounds: muzzle to wherever the round will land. */
  _emitTracer(p, speed) {
    const phys = this.physics;
    this._tracerFrom.copy(p.pos);
    let dist = Math.min(p.maxRange, 260);
    if (phys) {
      const hit = phys.raycast(p.pos, p.dir, dist, phys.MASK?.BULLET);
      if (hit?.hit) dist = hit.distance;
    }
    this._tracerTo.copy(p.pos).addScaledVector(p.dir, dist);
    this._tracerPayload.speed = speed;
    this._tracerPayload.weapon = p.weapon;
    this.ctx.events.emit('bullet:tracer', this._tracerPayload);
  }

  fixedUpdate(h) {
    const phys = this.physics;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.prev.copy(p.pos);
      // gravity + a linear drag term (good enough over game distances)
      p.vel.y += GRAVITY * h;
      const decay = Math.max(0, 1 - p.dragK * h);
      p.vel.multiplyScalar(decay);
      p.pos.addScaledVector(p.vel, h);
      p.age += h;

      this._seg.copy(p.pos).sub(p.prev);
      const segLen = this._seg.length();
      p.travelled += segLen;

      if (segLen > 1e-6 && phys) {
        this._hitDir.copy(this._seg).divideScalar(segLen);
        const hit = phys.raycast(p.prev, this._hitDir, segLen, phys.MASK?.BULLET);
        if (hit?.hit) {
          // Contact: hand the round to the penetration solver, which emits
          // `bullet:impact` for every entry and exit face it goes through.
          const range01 = Math.min(1, p.travelled / p.maxRange);
          const falloff = 1 - (1 - p.dropoff) * range01 * range01;
          phys.fireBullet({
            origin: p.prev,
            dir: this._hitDir,
            maxDist: Math.min(24, Math.max(1.5, p.maxRange - p.travelled + segLen)),
            damage: p.damage * falloff,
            penetration: p.penetration,
            dropoff: 1,
            mask: p.mask,
            source: p.source ?? this.playerSource,
          });
          this.stats.impacts++;
          this._retire(p);
          this.live.splice(i, 1);
          continue;
        }
      }

      if (p.travelled > p.maxRange || p.age > 5 || p.pos.y < -80) {
        this._retire(p);
        this.live.splice(i, 1);
      }
    }
    this.stats.live = this.live.length;
  }

  _retire(p) {
    p.alive = false;
    p.weapon = null;
  }

  clear() {
    for (const p of this.live) this._retire(p);
    this.live.length = 0;
  }
}
