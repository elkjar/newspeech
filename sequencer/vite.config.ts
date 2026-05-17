import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isTauri = !!process.env.TAURI_ENV_PLATFORM;

// Generates samples/index.json — the bundled-samples discovery index used
// by the runtime to enumerate kits without a hardcoded list. Build time:
// the index is emitted as an asset into dist/. Dev: a middleware serves a
// fresh scan on every request so dropping a new kit folder shows up after
// a refresh, no rebuild required.
function samplesIndex(): Plugin {
  const samplesDir = path.resolve(__dirname, 'public/samples');
  function scanIndex(): Array<{ kitPath: string; category: 'drum' | 'melodic' }> {
    const entries: Array<{ kitPath: string; category: 'drum' | 'melodic' }> = [];
    for (const category of ['drums', 'instruments', 'pads']) {
      const categoryDir = path.join(samplesDir, category);
      if (!fs.existsSync(categoryDir)) continue;
      for (const kit of fs.readdirSync(categoryDir)) {
        const kitDir = path.join(categoryDir, kit);
        if (!fs.statSync(kitDir).isDirectory()) continue;
        if (!fs.existsSync(path.join(kitDir, 'manifest.json'))) continue;
        entries.push({
          kitPath: `${category}/${kit}`,
          category: category === 'drums' ? 'drum' : 'melodic',
        });
      }
    }
    entries.sort((a, b) => a.kitPath.localeCompare(b.kitPath));
    return entries;
  }
  return {
    name: 'newspeech-samples-index',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.endsWith('/samples/index.json')) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(scanIndex()));
          return;
        }
        next();
      });
    },
    buildStart() {
      this.emitFile({
        type: 'asset',
        fileName: 'samples/index.json',
        source: JSON.stringify(scanIndex(), null, 2) + '\n',
      });
    },
  };
}

export default defineConfig({
  base: isTauri ? './' : '/sequencer/',
  clearScreen: false,
  server: {
    strictPort: true,
    port: isTauri ? 1420 : 5173,
    host: isTauri ? '127.0.0.1' : undefined,
  },
  plugins: [
    react(),
    samplesIndex(),
    {
      name: 'newspeech-fonts-passthrough',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url) return next();
          if (req.url.startsWith('/fonts/')) {
            const file = path.resolve(__dirname, '..', req.url.replace(/^\//, ''));
            if (fs.existsSync(file)) {
              res.setHeader('Content-Type', 'font/woff2');
              fs.createReadStream(file).pipe(res);
              return;
            }
          }
          next();
        });
      },
    },
  ],
});
