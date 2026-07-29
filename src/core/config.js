/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  low: {
    renderScale: 0.72,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 60,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
  },
  medium: {
    renderScale: 0.85,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
  },
  high: {
    renderScale: 1.0,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
  },
  ultra: {
    renderScale: 1.0,
    // 2048, not 4096: `CSM` clamps to 2048 anyway (src/render/csm.js:39 —
    // "4 x 4096 x R32F is a quarter of a gigabyte for shadows nobody can see"),
    // so the old 4096 declared a resolution the renderer never honoured and made
    // this table disagree with the shipped pipeline. Changing it alters nothing
    // at runtime; it only stops the preset lying about what ultra costs.
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
  },
};

export const DEFAULTS = {
  quality: 'ultra',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

/**
 * Pick a preset from what the machine actually is.
 *
 * Booting everyone at `ultra` is what made the game unplayable on integrated
 * graphics: at 1080p/DPR 1.5 the post chain alone reserves ~600 MB of render
 * targets (HDR + 4x MSAA viewmodel + 2 ping + MRT gbuffer + GTAO + SSR + TAA
 * history + bloom pyramid) on top of a 2048x2048x4 float shadow array and
 * ~1.8M triangles of geometry. An iGPU shares that with system RAM and the GPU
 * process is killed — the browser reports it as a tab crash, not as an error
 * the page can catch.
 *
 * Deliberately pessimistic. Guessing one preset too low costs some shadow
 * resolution; guessing one too high costs the whole session. `ultra` is now
 * opt-in only, via `?q=ultra`.
 */
export function detectQuality() {
  if (typeof document === 'undefined') return 'high';

  let gl = null;
  let renderer = '';
  try {
    gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
  } catch {
    /* probing must never throw */
  }
  if (!gl) return 'low';
  const r = renderer.toLowerCase();

  // Software rasterisers: nothing above `low` is remotely interactive.
  if (/swiftshader|llvmpipe|softwarerasterizer|basic render|microsoft basic/.test(r)) return 'low';

  // Mobile/tablet GPUs, and anything driven by a coarse pointer.
  const coarse = matchMedia?.('(pointer: coarse)')?.matches;
  if (/adreno|mali|powervr|apple gpu/.test(r) || coarse) return 'low';

  const mem = navigator.deviceMemory ?? 0; // GB, Chromium only, 0 when unknown
  const cores = navigator.hardwareConcurrency ?? 0;
  if ((mem && mem <= 4) || (cores && cores <= 4)) return 'low';

  // Integrated parts share system RAM with everything else on the machine.
  // "Radeon Graphics"/"Radeon Vega" with no model number is an APU; a discrete
  // Radeon always carries an RX/Pro model, so match the bare names only.
  const integrated =
    /intel|uhd graphics|hd graphics|iris/.test(r) ||
    /radeon\s*(\(tm\)\s*)?(vega\s*)?graphics\b/.test(r);
  if (integrated) return mem >= 16 ? 'medium' : 'low';

  // Discrete cards and Apple silicon. Still not `ultra` — that is opt-in.
  return 'high';
}

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}
