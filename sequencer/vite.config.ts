import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isTauri = !!process.env.TAURI_ENV_PLATFORM;

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
