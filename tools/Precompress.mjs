/**
 * Emit .br and .gz siblings for every compressible file in a build.
 *
 * The deploy host (Apache at dev.jdayers.com) compresses on the fly with
 * mod_deflate — the ETag comes back suffixed `-gzip` — but mod_brotli is not
 * configured, so a browser advertising `br` still gets gzip. Measured on the
 * 1.64 MB chunk: gzip 500,434 B vs brotli-11 409,161 B, i.e. 91 KB (18.2%) of
 * dead weight on every cold load.
 *
 * Precompressing here rather than asking for a server module means the win
 * needs only mod_rewrite + mod_headers (see public/.htaccess), which any Apache
 * has. Brotli-11 is far too slow to run per-request anyway; it belongs at build
 * time, where the file is written once and served thousands of times.
 *
 * `zlib` is in node's stdlib, so this adds no dependency — ARCHITECTURE.md
 * rule 3 allows `three` only.
 *
 * Usage: node tools/Precompress.mjs [distDir]   (defaults to ./dist)
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { constants, brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const br = promisify(brotliCompress);
const gz = promisify(gzip);

const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.map', '.wasm']);
/** Below this, the request overhead dwarfs the saving and Apache's own gzip is fine. */
const MIN_BYTES = 1024;

const kb = (b) => `${(b / 1024).toFixed(1)} kB`;
const pct = (part, whole) => (whole ? `${((1 - part / whole) * 100).toFixed(1)}% off` : '—');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}

// Trailing slash stripped: the progress line slices by `dist.length + 1`, so
// `dist/` ate the first character of every path it printed.
const dist = (process.argv[2] ?? 'dist').replace(/[/\\]+$/, '') || '.';

try {
  if (!(await stat(dist)).isDirectory()) throw new Error('not a directory');
} catch (err) {
  // Report what actually went wrong: a bare "no build here" sent anyone hitting
  // EACCES on an existing directory off rebuilding for no reason.
  const why = err?.code === 'ENOENT' ? 'no build there — run the build first' : err.message;
  console.error(`[precompress] cannot read "${dist}": ${why}`);
  process.exit(1);
}

let raw = 0;
let brTotal = 0;
let gzTotal = 0;
let n = 0;

for await (const file of walk(dist)) {
  if (!COMPRESSIBLE.has(extname(file))) continue;
  // Never recompress our own output.
  if (file.endsWith('.br') || file.endsWith('.gz')) continue;

  const buf = await readFile(file);
  if (buf.length < MIN_BYTES) continue;

  const [b, g] = await Promise.all([
    br(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }),
    gz(buf, { level: 9 }),
  ]);

  // A precompressed file that is not actually smaller is pure liability: it
  // would be served in place of the original for no gain.
  if (b.length < buf.length) {
    await writeFile(`${file}.br`, b);
    brTotal += b.length;
  }
  if (g.length < buf.length) {
    await writeFile(`${file}.gz`, g);
    gzTotal += g.length;
  }

  raw += buf.length;
  n++;
  console.log(
    `  ${file.slice(dist.length + 1)}  ${kb(buf.length)} → br ${kb(b.length)} · gz ${kb(g.length)}`,
  );
}

if (!n) {
  console.log('[precompress] nothing to compress');
} else {
  console.log(
    `[precompress] ${n} file(s): ${kb(raw)} raw → ${kb(brTotal)} br (${pct(brTotal, raw)}), ${kb(gzTotal)} gz (${pct(gzTotal, raw)})`,
  );
  console.log(`[precompress] br saves ${kb(gzTotal - brTotal)} over gz on a cold load`);
}
