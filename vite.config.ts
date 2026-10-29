import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const tauriConf = JSON.parse(
  readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Settings → About shows the same version the updater compares against.
  define: { __APP_VERSION__: JSON.stringify(tauriConf.version) },
  build: {
    rollupOptions: {
      // The menu bar popover gets its own small bundle (never the full App).
      input: { main: 'index.html', tray: 'tray.html' },
    },
  },
  server: {
    port: 5743,
    strictPort: true, // fail fast if port is already in use instead of silently picking another
  },
})
