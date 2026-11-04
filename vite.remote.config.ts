import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Phone Remote page, served by the relay (relay/) rather than the app.
// `npm run deploy` in relay/ builds it into relay/public first.
export default defineConfig({
  plugins: [react()],
  root: 'src/remote',
  build: {
    outDir: '../../relay/public',
    emptyOutDir: true,
  },
  server: {
    port: 5744,
    // `wrangler dev` runs the relay on 8787.
    proxy: { '/room': { target: 'ws://localhost:8787', ws: true } },
  },
})
