import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { apiProxyTarget } from './devProxy';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** Prints where /api goes once the dev server is up, next to Vite's own URLs. */
function apiProxyInfo(target: string): Plugin {
  return {
    name: 'lyren-api-proxy-info',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        setTimeout(() => server.config.logger.info(`  ➜  API:     /api is proxied to ${target}`), 0);
      });
    },
  };
}

export default defineConfig(({ command }) => {
  // Only the dev server proxies; a production build must not depend on (or fail over) PORT.
  const apiTarget = command === 'serve' ? apiProxyTarget(process.env) : null;
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    publicDir: 'public',
    plugins: [react(), tailwindcss(), ...(apiTarget ? [apiProxyInfo(apiTarget)] : [])],
    resolve: {
      alias: {
        '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      port: 5173,
      host: true,
      // The API: PORT (and HOST) as the API server reads them, default 127.0.0.1:8080, or
      // LYREN_API_URL. See devProxy.ts.
      proxy: apiTarget ? { '/api': { target: apiTarget, changeOrigin: false } } : undefined,
    },
    build: {
      outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
      emptyOutDir: true,
      sourcemap: true,
      chunkSizeWarningLimit: 1500,
    },
  };
});
