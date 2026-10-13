import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5743,
    strictPort: true, // fail fast if port is already in use instead of silently picking another
  },
})
