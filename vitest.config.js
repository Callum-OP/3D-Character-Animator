import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Same plugin set as vite.config.js, plus test config. Kept separate so
// `vite build` never picks up test-only settings.
export default defineConfig({
  base: './',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
})