/**
 * Terminal ballistics — material-thickness bullet penetration.
 *
 * A round carries a *penetration budget* expressed in metres of a reference
 * material. Every surface has a `penDepth`: the thickness of that material the
 * reference round defeats. Passing through consumes budget proportional to
 * thickness/penDepth, bleeds damage, and yaws the round slightly (deflection is
 * drawn from ctx.rng so captures reproduce exactly).
 *
 * Thickness is measured by shooting a second ray from just past the entry point
 * and looking for the *backface* of the same object. Level geometry that is
 * modelled as a single-sided plane (very common for drywall and fences) has no
 * backface, so we fall back to a nominal sheet thickness.
 *
 * `bullet:impact` is emitted on entry AND on exit, with `exit: true` on the
 * latter so fx can pick a spall/dust variant instead of a crater.
 */

import { SURFACE_PROPS, surfaceName, MASK } from './surfaces.js';

const MAX_LAYERS = 6;
/** How far past an entry point we look for the exit face. */
const EXIT_PROBE = 1.6;
/** Assumed thickness of single-sided geometry, metres. */
const SHEET_THICKNESS = 0.018;
/** Probe raycasts spent walking one solid; bounds a body's stacked hitboxes. */
const MAX_PROBE_STEPS = 8;

export class Ballistics {
  constructor(phys) {
    this.phys = phys;
    this.rng = null;
    /** Reusable result list; contents are valid until the next fire(). */
    this.impacts = [];
    for (let i = 0; i < MAX_LAYERS * 2 + 2; i++) {
      this.impacts.push({
        point: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 0 },
        surface: 'concrete',
        exit: false,
        damage: 0,
        distance: 0,
        object: null,
      });
    }
    this.impactCount = 0;
  }

  /**
   * @param {object} o
   *   origin      {x,y,z}
   *   dir         {x,y,z} unit
   *   maxDist     metres (default 400)
   *   damage      base damage at the muzzle
   *   penetration budget, 1.0 = 7.62 rifle, 0.35 = pistol, 2.2 = .50 / AP
   *   mask        collision mask (default MASK.BULLET)
   *   dropoff     damage retained at maxDist, 0..1
   *   source      who fired; forwarded on `damage:dealt` so credit and range
   *               falloff are measured from the shooter, not from the player
   * @returns {number} number of impacts written into `this.impacts`
   */
  fire(o) {
    const phys = this.phys;
    const rng = o.rng ?? this.rng;
    let ox = o.origin.x, oy = o.origin.y, oz = o.origin.z;
    let dx = o.dir.x, dy = o.dir.y, dz = o.dir.z;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;

    let remaining = o.maxDist ?? 400;
    let damage = o.damage ?? 34;
    let power = o.penetration ?? 1.0;
    const mask = o.mask ?? MASK.BULLET;
    const dropoff = o.dropoff ?? 0.55;
    const startX = ox, startY = oy, startZ = oz;
    const emit = o.emit !== false;

    const source = o.source ?? null;

    this.impactCount = 0;
    // Exactly one `damage:dealt` per actor per round. Hitboxes overlap (an arm
    // capsule sits inside the torso) and a body is thicker than one layer, so
    // without this a single round can re-enter the same actor and damage it
    // again a few millimetres later.
    const struck = this._struck ?? (this._struck = []);
    struck.length = 0;

    for (let layer = 0; layer < MAX_LAYERS && remaining > 0.01; layer++) {
      const hit = phys.raycast(ox, oy, oz, dx, dy, dz, remaining, mask);
      if (!hit.hit) break;

      let deal = true;
      if (hit.actor) {
        deal = struck.indexOf(hit.actor) < 0;
        if (deal) struck.push(hit.actor);
      }

      const travelled = Math.hypot(hit.point.x - startX, hit.point.y - startY, hit.point.z - startZ);
      // Muzzle-to-target energy loss.
      const range01 = Math.min(1, travelled / (o.maxDist ?? 400));
      const rangeMul = 1 - (1 - dropoff) * range01 * range01;

      const si = hit.surfaceIndex;
      const props = SURFACE_PROPS[si] ?? SURFACE_PROPS[0];

      this._push(hit.point, hit.normal, si, false, damage * rangeMul, travelled, hit.object);
      if (emit) {
        phys.emitImpact(
          hit.point.x, hit.point.y, hit.point.z,
          hit.normal.x, hit.normal.y, hit.normal.z,
          dx, dy, dz,
          si, damage * rangeMul, false, hit, source, deal
        );
      }

      // Actors and dynamic bodies take the hit and the round keeps going only
      // if it has plenty of budget left (flesh is soft but a torso is thick).
      if (hit.collider && hit.collider.onHit) {
        hit.collider.onHit(hit, damage * rangeMul, dx, dy, dz);
      }
      if (hit.body) {
        const j = (o.impulse ?? 6) * damage * 0.02;
        hit.body.applyImpulse(dx * j, dy * j, dz * j, hit.point.x, hit.point.y, hit.point.z);
      }
      if (hit.ragdoll) {
        hit.ragdoll.applyImpulse(
          hit.point.x, hit.point.y, hit.point.z,
          dx * damage * 0.9, dy * damage * 0.9, dz * damage * 0.9,
          0.35
        );
      }

      // ---- can we get through? ----
      const budget = props.penDepth * power;
      if (budget <= 1e-4) break;

      const thick = this._measureThickness(hit, dx, dy, dz, mask, Math.min(EXIT_PROBE, remaining));
      if (thick.distance > budget) break; // round stops in the material

      const frac = thick.distance / budget;
      // Exit impact — normal points out of the far face.
      const exDamage = damage * rangeMul * Math.max(0.05, 1 - props.energyLoss * frac);
      this._push(thick.point, thick.normal, si, true, exDamage, travelled + thick.distance, hit.object);
      if (emit) {
        phys.emitImpact(
          thick.point.x, thick.point.y, thick.point.z,
          thick.normal.x, thick.normal.y, thick.normal.z,
          dx, dy, dz,
          si, exDamage, true, hit, source
        );
      }

      // ---- degrade and continue ----
      damage *= Math.max(0.05, 1 - props.energyLoss * frac);
      power *= Math.max(0, 1 - frac);
      if (power < 0.02 || damage < 1) break;

      if (rng && props.deflect > 0) {
        const spread = props.deflect * frac;
        // Build an orthonormal frame around the current direction and yaw/pitch.
        let ux = 0, uy = 1, uz = 0;
        if (Math.abs(dy) > 0.9) { ux = 1; uy = 0; }
        let rx = uy * dz - uz * dy, ry = uz * dx - ux * dz, rz = ux * dy - uy * dx;
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        const sx = dy * rz - dz * ry, sy = dz * rx - dx * rz, sz = dx * ry - dy * rx;
        const a = rng.gauss() * spread;
        const b = rng.gauss() * spread;
        dx += rx * a + sx * b;
        dy += ry * a + sy * b;
        dz += rz * a + sz * b;
        const nl = Math.hypot(dx, dy, dz) || 1;
        dx /= nl; dy /= nl; dz /= nl;
      }

      // Step past the exit face and keep flying.
      const eps = 0.004;
      ox = thick.point.x + dx * eps;
      oy = thick.point.y + dy * eps;
      oz = thick.point.z + dz * eps;
      // Decrement by *this segment's* travel, not the total from the muzzle —
      // `travelled` is cumulative and would be double-counted on layer 2+.
      remaining -= hit.distance + thick.distance + eps;
    }

    return this.impactCount;
  }

  /**
   * Distance from an entry hit to where the round leaves the material, plus the
   * exit point and its outward normal.
   */
  _measureThickness(entry, dx, dy, dz, mask, probe) {
    const phys = this.phys;
    const eps = 0.0015;
    const out = this._thick ?? (this._thick = {
      distance: 0,
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 0 },
      backface: false,
    });

    // Analytic shapes have no winding to report: `frontFace` stays true for a
    // collider capsule and is never written for a ragdoll bone, so demanding a
    // backface here sent every actor down the sheet branch and stepped the ray
    // 18 mm — still inside the body it just entered, which is what made one
    // round deal its damage twice. Identity is what tells us we are still in
    // the thing we entered, and a body is ONE solid: an actor's hitboxes
    // overlap (an arm capsule sits inside the torso), so keep walking while the
    // probe stays on the same actor and take the LAST crossing as the exit.
    // Consequence, deliberate: the exit is the far side of the WHOLE body, so a
    // torso now costs ~0.37-0.44 m of the flesh budget instead of 18 mm, and an
    // intra-body air gap (an outstretched arm) is charged as thickness. A round
    // can therefore stop inside an actor where it previously always exited.
    // A rigid body is convex and analytic, but rayObb/raySphere report t = 0 for
    // a ray that starts inside it, so the forward walk below cannot find its far
    // face — every debris crate was measured as an 18 mm sheet and re-entered
    // half a dozen times, one entry+exit impact pair each. Probe backwards from
    // just beyond the body instead: for a convex shape that lands exactly on the
    // exit face, and raycast() already reports the normal facing the probe ray,
    // which for a backwards ray is the outward normal we want.
    if (entry.body) {
      const b = entry.body;
      const br =
        b.shape === 'sphere' ? b.radius
        : b.shape === 'capsule' ? b.halfHeight + b.radius
        : Math.hypot(b.hx, b.hy, b.hz);
      const span = br * 2 + eps;
      if (span <= probe) {
        const back = phys.raycast(
          entry.point.x + dx * span, entry.point.y + dy * span, entry.point.z + dz * span,
          -dx, -dy, -dz, span, mask
        );
        if (back.hit && back.body === b) {
          out.distance = Math.max(eps, span - back.distance);
          out.point.x = back.point.x; out.point.y = back.point.y; out.point.z = back.point.z;
          out.normal.x = back.normal.x; out.normal.y = back.normal.y; out.normal.z = back.normal.z;
          out.backface = true;
          return out;
        }
      }
    }

    let ox = entry.point.x + dx * eps;
    let oy = entry.point.y + dy * eps;
    let oz = entry.point.z + dz * eps;
    let travelled = eps;
    let ex = 0, ey = 0, ez = 0, enx = 0, eny = 0, enz = 0;
    let found = false;

    for (let step = 0; step < MAX_PROBE_STEPS && travelled < probe; step++) {
      const h = phys.raycast(ox, oy, oz, dx, dy, dz, probe - travelled, mask);
      if (!h.hit) break;
      const same =
        (entry.collider && h.collider === entry.collider) ||
        (entry.ragdoll && h.ragdoll === entry.ragdoll) ||
        (entry.actor && h.actor === entry.actor) ||
        (!h.frontFace && h.object === entry.object);
      if (!same) break;
      travelled += h.distance;
      ex = h.point.x; ey = h.point.y; ez = h.point.z;
      // raycast() reports normals facing the shooter; the exit face's outward
      // normal is the opposite.
      enx = -h.normal.x; eny = -h.normal.y; enz = -h.normal.z;
      found = true;
      if (h.triangle >= 0) break; // a mesh backface is the real exit
      ox = ex + dx * eps; oy = ey + dy * eps; oz = ez + dz * eps;
      travelled += eps;
    }

    if (found) {
      out.distance = travelled;
      out.point.x = ex; out.point.y = ey; out.point.z = ez;
      out.normal.x = enx; out.normal.y = eny; out.normal.z = enz;
      out.backface = true;
    } else {
      // Single-sided sheet: nominal thickness along the incidence angle.
      const cos = Math.abs(
        entry.normal.x * dx + entry.normal.y * dy + entry.normal.z * dz
      );
      const t = SHEET_THICKNESS / Math.max(0.2, cos);
      out.distance = t;
      out.point.x = entry.point.x + dx * t;
      out.point.y = entry.point.y + dy * t;
      out.point.z = entry.point.z + dz * t;
      out.normal.x = -entry.normal.x;
      out.normal.y = -entry.normal.y;
      out.normal.z = -entry.normal.z;
      out.backface = false;
    }
    return out;
  }

  _push(point, normal, si, exit, damage, distance, object) {
    if (this.impactCount >= this.impacts.length) return;
    const r = this.impacts[this.impactCount++];
    r.point.x = point.x; r.point.y = point.y; r.point.z = point.z;
    r.normal.x = normal.x; r.normal.y = normal.y; r.normal.z = normal.z;
    r.surface = surfaceName(si);
    r.exit = exit;
    r.damage = damage;
    r.distance = distance;
    r.object = object;
  }
}
