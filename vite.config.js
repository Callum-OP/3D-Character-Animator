import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Same plugin set as vite.config.js, plus test config. Kept separate so
// `vite build` never picks up test-only settings.
export default defineConfig({
  base: './',
  plugins: [react()],
  // The USD reader runs in an inline (blob) module worker; module workers keep `import.meta.url` working.
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})