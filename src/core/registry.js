/**
 * Subsystem registry + shared context.
 *
 * CONTRACT — every subsystem is a class with:
 *   static id      : string, unique. Other systems fetch it via ctx.get(id).
 *   static deps    : string[] of subsystem ids that must init first.
 *   async init(ctx): build resources. May await asset loads.
 *   update(dt,ctx) : variable-rate, once per frame, before render.
 *   fixedUpdate(h,ctx): fixed-rate (PHYSICS_HZ), 0..N times per frame. Optional.
 *   lateUpdate(dt,ctx): after all update(), before render. Optional.
 *   resize(w,h,ctx): viewport changed. Optional.
 *   dispose()      : free GPU/CPU resources. Optional.
 *
 * Subsystems MUST NOT import each other directly — go through ctx.get(id).
 * That keeps the dependency graph explicit and lets agents own files in isolation.
 */

export class Registry {
  #systems = new Map();
  #order = [];

  add(system) {
    const id = system.constructor.id;
    if (!id) throw new Error(`${system.constructor.name} is missing a static id`);
    if (this.#systems.has(id)) throw new Error(`duplicate subsystem id "${id}"`);
    this.#systems.set(id, system);
    return this;
  }

  get(id) {
    const s = this.#systems.get(id);
    if (!s) throw new Error(`subsystem "${id}" not registered`);
    return s;
  }

  /** Non-throwing lookup for optional dependencies. */
  peek(id) {
    return this.#systems.get(id) ?? null;
  }

  has(id) {
    return this.#systems.has(id);
  }

  /** Topological sort over static deps; throws on cycles or missing deps. */
  resolve() {
    const seen = new Map(); // id -> 0 visiting, 1 done
    const out = [];
    const visit = (id, from) => {
      const state = seen.get(id);
      if (state === 1) return;
      if (state === 0) throw new Error(`dependency cycle at "${id}" (via ${from})`);
      const sys = this.#systems.get(id);
      if (!sys) throw new Error(`"${from}" depends on unregistered subsystem "${id}"`);
      seen.set(id, 0);
      for (const d of sys.constructor.deps ?? []) visit(d, id);
      seen.set(id, 1);
      out.push(sys);
    };
    for (const id of this.#systems.keys()) visit(id, '<root>');
    this.#order = out;
    return out;
  }

  get ordered() {
    return this.#order.length ? this.#order : this.resolve();
  }

  /** Systems that implement `method`, in dependency order. Cached per method. */
  #cache = new Map();
  with(method) {
    let list = this.#cache.get(method);
    if (!list) {
      list = this.ordered.filter((s) => typeof s[method] === 'function');
      this.#cache.set(method, list);
    }
    return list;
  }

  invalidate() {
    this.#cache.clear();
  }
}

/** Minimal typed event bus. Handlers are called synchronously. */
export class EventBus {
  #map = new Map();
  /**
   * Array mirror of each handler Set, rebuilt lazily and invalidated by on()/off().
   * emit() used to spread the Set into a fresh array every dispatch so handlers
   * could unsubscribe mid-dispatch; that allocated on the gameplay hot path
   * (weapon:fire / weapon:shell / bullet:tracer / bullet:impact / damage:dealt,
   * per shot, per shooter). Subscriptions only change at init and dispose, so the
   * mirror is built once and emit() allocates nothing.
   */
  #lists = new Map();

  on(type, fn) {
    let set = this.#map.get(type);
    if (!set) this.#map.set(type, (set = new Set()));
    set.add(fn);
    this.#lists.delete(type);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (e) => {
      off();
      fn(e);
    });
    return off;
  }

  off(type, fn) {
    if (this.#map.get(type)?.delete(fn)) this.#lists.delete(type);
  }

  emit(type, payload) {
    const set = this.#map.get(type);
    if (!set || set.size === 0) return;
    let list = this.#lists.get(type);
    if (!list) this.#lists.set(type, (list = [...set]));
    // `list` is a snapshot held in a local: a handler that calls on()/off()
    // during dispatch drops the cached mirror, but this loop keeps walking the
    // array it started with — same semantics the old `[...set]` copy had.
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        console.error(`[events] handler for "${type}" threw:`, err);
      }
    }
  }

  clear() {
    this.#map.clear();
    this.#lists.clear();
  }
}
