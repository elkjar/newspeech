import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/sequencer/',
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
