import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
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

for (const url of [scriptMatch[1], styleMatch[1]]) {
  const assetPath = path.join(dist, url.replace(/^\.\//, ''))
  fs.rmSync(assetPath, { force: true })
}
for (const entry of fs.readdirSync(path.join(dist, 'assets'))) {
  fs.rmSync(path.join(dist, 'assets', entry), { force: true })
}
fs.rmSync(path.join(dist, 'assets'), { recursive: true, force: true })