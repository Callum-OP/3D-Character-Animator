import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Minimal Vite config. No backend — this is a pure static/client-side app.
export default defineConfig({
  plugins: [react()],
  server: {
    open: true,
  },
})
