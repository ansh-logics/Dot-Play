import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The TV app (Android TV): its own small bundle, never the desktop App. The TV has 1 GB of
// memory and a slow chip, so nothing heavy (blur, motion, the liquid glass layer) is pulled in.
export default defineConfig({
  plugins: [react()],
  root: 'src/tv',
  build: {
    outDir: '../../dist-tv',
    emptyOutDir: true,
    target: 'chrome81', // the oldest WebView a supported TV may still carry
  },
  server: {
    port: 5745,
    strictPort: true,
  },
})
