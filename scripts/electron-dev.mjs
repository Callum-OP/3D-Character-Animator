// Dev runner: starts the Vite dev server (HMR), then opens Electron pointed at it.
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const electronPath = createRequire(import.meta.url)('electron')

const server = await createServer({ server: { port: 5173, strictPort: false } })
await server.listen()
const url = server.resolvedUrls.local[0]

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_START_URL: url },
})
child.on('exit', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
