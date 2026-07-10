import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Minimal Vite config. No backend — this is a pure static/client-side app.
//
// `base` only matters for production builds deployed to GitHub Pages, which
// serves this project site from the /<repo>/ subpath. Local dev/preview stays at
// '/' so opening http://localhost:5173/ works normally.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/3D-Character-Animator/' : '/',
  plugins: [react()],
  server: {
    open: true,
  },
}))
