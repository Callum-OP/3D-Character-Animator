import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Optional first argument = a different dist folder (the tests use this).
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist')
const htmlPath = path.join(dist, 'index.html')
let html = fs.readFileSync(htmlPath, 'utf8')

const scriptMatch = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/)
const styleMatch = html.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/)
if (!scriptMatch || !styleMatch) throw new Error('Could not find Vite script or stylesheet in dist/index.html')

const readAsset = (url) => fs.readFileSync(path.join(dist, url.replace(/^\.\//, '')), 'utf8')
const script = readAsset(scriptMatch[1])
const style = readAsset(styleMatch[1])

html = html
  .replace(scriptMatch[0], () => `<script type="module">${script}</script>`)
  .replace(styleMatch[0], () => `<style>${style}</style>`)
fs.writeFileSync(htmlPath, html)

// The script and stylesheet are folded into index.html, so those two files go.
// The WebAssembly files (TinyUSDZ for .usdz, unrar for .rar) are fetched at runtime and cannot be
// inlined. Their addresses in the bundle are relative to the script, and the script now lives inside
// index.html, so they must sit NEXT TO index.html (not in assets/). Deleting them is what made itch.io
// answer those requests with an HTML page ("expected magic word 00 61 73 6d").
for (const url of [scriptMatch[1], styleMatch[1]]) {
  fs.rmSync(path.join(dist, url.replace(/^\.\//, '')), { force: true })
}
const assetsDir = path.join(dist, 'assets')
if (fs.existsSync(assetsDir)) {
  for (const entry of fs.readdirSync(assetsDir)) {
    fs.renameSync(path.join(assetsDir, entry), path.join(dist, entry))
  }
  fs.rmSync(assetsDir, { recursive: true, force: true })
}
