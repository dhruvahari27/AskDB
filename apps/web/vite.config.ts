import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Ports come from the repo-root .env (WEB_PORT for this dev server, PORT for the API) so they are changed in one place.
// The browser talks to /api on its own origin; Vite forwards it to Express so cookies and SSE just work.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(__dirname, '../..'), '');
  const webPort = Number(env.WEB_PORT || 4710);
  const apiPort = Number(env.PORT || 4711);
  return {
    plugins: [react()],
    server: {
      port: webPort,
      strictPort: true, // fail loudly instead of hopping to another port (the API's CORS origin would no longer match)
      proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false } },
    },
    build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  };
});
