import { defineConfig } from 'vite';

// base: './' keeps asset URLs relative so the built site works regardless of
// where it's hosted — root path on Cloudflare Pages, or a sub-path like
// `/annotate-anything/` on GitHub Pages. No subdirectory config needed.
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
  },
});
