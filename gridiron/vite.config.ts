import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

// With DISABLE_HMR=true the dev client (/@vite/client) still loads, since CSS and the module runtime need it, but it must
// not dial its hot-reload socket: there is no socket server then (server.ws below), and the YUR AI Athletics side
// browser blocks ws:// anyway, so every page load would log a failed connection.
const noHmrSocket = (): Plugin => ({
  name: 'gridiron:no-hmr-socket',
  apply: 'serve',
  enforce: 'post',
  transform(code, id) {
    if (!/[\\/]vite[\\/]dist[\\/]client[\\/]client\.mjs$/.test(id.split('?')[0])) return;
    const connect = 'transport.connect(createHMRHandler(handleMessage));';
    if (!code.includes(connect)) {
      this.warn('DISABLE_HMR: this Vite client is new to gridiron:no-hmr-socket; it will still dial its socket');
      return;
    }
    return {code: code.replace(connect, '/* DISABLE_HMR=true: no hot-reload socket */'), map: null};
  },
});

// Local data stays out of git: the seed exports (src/data/*.seed.json, from recruit/export_firestore.py) and the
// Firebase web config (firebase-applet-config.json). A checkout without them builds from the committed samples;
// tsconfig.json maps the same names in the same order.
const localOrSample = (): Plugin => ({
  name: 'gridiron:local-or-sample',
  enforce: 'pre',
  resolveId(source) {
    const seed = /^@seed\/([a-z0-9-]+\.seed\.json)$/.exec(source);
    const [local, sample] = seed
      ? [path.join('src', 'data', seed[1]), path.join('src', 'data', 'sample', seed[1])]
      : source === '@firebase-config' ? ['firebase-applet-config.json', 'firebase-applet-config.example.json'] : [];
    if (!local) return null;
    const file = path.resolve(__dirname, local);
    return fs.existsSync(file) ? file : path.resolve(__dirname, sample);
  },
});

export default defineConfig(() => {
  const noHmr = process.env.DISABLE_HMR === 'true';
  return {
    plugins: [localOrSample(), react(), tailwindcss(), ...(noHmr ? [noHmrSocket()] : [])],
    // No `define` for GEMINI_API_KEY: the key stays on the server (server.ts /api/gemini/generate), never in the bundle.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // and no hot-reload socket server (port 24678 in middleware mode, where a second instance would collide)
      ...(noHmr ? {ws: false as const} : {}),
    },
  };
});
