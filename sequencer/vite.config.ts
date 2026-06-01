import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isTauri = !!process.env.TAURI_ENV_PLATFORM;

// Single source of truth for the app version: package.json. tauri.conf.json
// reads it too (version: "../package.json"), so a release is one edit here.
// Injected as the __APP_VERSION__ compile-time constant for UI display.
const APP_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
).version as string;

// Generates samples/index.json — the bundled-samples discovery index used
// by the runtime to enumerate kits without a hardcoded list. Build time:
// the index is emitted as an asset into dist/. Dev: a middleware serves a
// fresh scan on every request so dropping a new kit folder shows up after
// a refresh, no rebuild required.
function samplesIndex(): Plugin {
  const samplesDir = path.resolve(__dirname, 'public/samples');
  // Mirrors the Rust scanner's CATEGORIES list (src-tauri/src/samples.rs).
  // Drum is the only category that maps to drum-section gating; the rest
  // are melodic. The picker further subcategorizes melodic kits by parent
  // folder for the UI.
  const CATEGORIES: Array<[string, 'drum' | 'melodic']> = [
    ['drums', 'drum'],
    ['instruments', 'melodic'],
    ['pads', 'melodic'],
    ['bass', 'melodic'],
    ['textures', 'melodic'],
  ];
  function scanIndex(): Array<{ kitPath: string; category: 'drum' | 'melodic' }> {
    const entries: Array<{ kitPath: string; category: 'drum' | 'melodic' }> = [];
    for (const [folder, cat] of CATEGORIES) {
      const categoryDir = path.join(samplesDir, folder);
      if (!fs.existsSync(categoryDir)) continue;
      for (const kit of fs.readdirSync(categoryDir)) {
        const kitDir = path.join(categoryDir, kit);
        if (!fs.statSync(kitDir).isDirectory()) continue;
        if (!fs.existsSync(path.join(kitDir, 'manifest.json'))) continue;
        entries.push({
          kitPath: `${folder}/${kit}`,
          category: cat,
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
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
    // Tauri builds don't load bundled samples — the app reads from the
    // user samples directory only (per the 2026-05-24 direction). Vite's
    // publicDir auto-copies ALL of public/ to dist/, so without this hook
    // the .app ships ~140MB of dead-weight WAVs inside the frontend
    // bundle. Web build still ships them (only source of kits there).
    {
      name: 'newspeech-strip-samples-for-tauri',
      apply: 'build',
      closeBundle() {
        if (!isTauri) return;
        const dir = path.resolve(__dirname, 'dist/samples');
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    },
  ],
});
