import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
