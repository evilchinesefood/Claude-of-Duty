import { defineConfig } from 'vite';

export default defineConfig({
  // Bind IPv4 explicitly: the default `localhost` binds ::1 only on macOS,
  // which the capture harness (127.0.0.1) cannot reach.
  // `hmr: false` when the capture harness owns the server (OW_NO_HMR=1): a file
  // saved by a concurrently-working agent otherwise reloads the page mid-capture
  // and playwright fails with "Execution context was destroyed".
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: process.env.OW_NO_HMR ? false : undefined,
  },
  preview: { host: '127.0.0.1' },
  // Sourcemaps are opt-in (`OW_SOURCEMAP=1 npm run build`): the map is 6.6 MB
  // against a 1.6 MB chunk and carries sourcesContent for the whole tree, so a
  // plain `npm run build` should not be publishing it.
  build: {
    target: 'es2022',
    sourcemap: !['', '0', 'false', undefined].includes(process.env.OW_SOURCEMAP),
    chunkSizeWarningLimit: 4096,
  },
  // Large binary game assets served verbatim.
  assetsInclude: ['**/*.ktx2', '**/*.hdr', '**/*.exr', '**/*.bin', '**/*.glb'],
});
