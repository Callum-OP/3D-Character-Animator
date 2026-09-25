'use strict'
// Electron shell for Animare 3D Animator.
// The frontend is the existing Vite build in ../dist, served over a private
// app:// scheme (a secure context, so IndexedDB, File System Access, fetch() of
// bundled assets etc. behave like they do on the hosted site). There is no
// native/backend surface: the renderer runs sandboxed with no preload.

const { app, BrowserWindow, Menu, protocol, net, shell, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const DIST = path.join(__dirname, '..', 'dist')
const DEV_URL = process.env.ELECTRON_START_URL || ''
const APP_ORIGIN = 'app://app'
const ICON = path.join(__dirname, '..', 'build', 'icon.png')

// --- GPU -------------------------------------------------------------------
// Hardware acceleration is left ON (never call app.disableHardwareAcceleration).
// ignore-gpu-blocklist stops Chromium silently falling back to software WebGL
// on drivers it is over-cautious about (notably Windows-on-ARM).
app.commandLine.appendSwitch('ignore-gpu-blocklist')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow = null

function isOwnOrigin(url) {
  try {
    const origin = new URL(url).origin
    return origin === 'app://app' || (DEV_URL && origin === new URL(DEV_URL).origin)
  } catch {
    return false
  }
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url)
    let rel = decodeURIComponent(pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const file = path.normalize(path.join(DIST, rel))
    // Never serve anything outside dist/ (path traversal guard).
    if (file !== DIST && !file.startsWith(DIST + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })
}

function hardenSession() {
  const allowed = new Set(['fileSystem', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen'])
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed.has(permission) && isOwnOrigin(details.requestingUrl || wc.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => {
    return allowed.has(permission) && isOwnOrigin(origin)
  })
}

function buildMenu() {
  // No default menu: it carries the browser-zoom, reload and devtools accelerators
  // (Ctrl +/-/0, Ctrl+R, ...) which fight the app's own viewport zoom and shortcuts.
  // macOS still needs an Edit menu or copy/paste stops working in text fields.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]),
    )
  } else {
    Menu.setApplicationMenu(null)
  }
}

// GPU/renderer crash recovery: reload at most 3 times per 30 s so a genuinely
// broken GPU can't spin forever.
const crashTimes = []
function recoverRenderer(win) {
  const now = Date.now()
  while (crashTimes.length && now - crashTimes[0] > 30000) crashTimes.shift()
  crashTimes.push(now)
  if (crashTimes.length > 3 || win.isDestroyed()) return
  win.webContents.reload()
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#101114',
    title: 'Animare 3D Animator',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    //titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1e1e1e', // Background color of the title bar area
      symbolColor: '#ffffff', // Color of the minimize/maximize/close icons
      height: 35
    },
  })
  mainWindow = win
  const wc = win.webContents

  // Lock page/pinch zoom at 100%. The app zooms the 3D camera itself (wheel,
  // trackpad pinch and the on-screen +/- buttons); browser-level zoom would
  // scale the whole UI instead.
  wc.setVisualZoomLevelLimits(1, 1)
  wc.on('did-finish-load', () => wc.setZoomFactor(1))

  win.once('ready-to-show', () => win.show())

  // External links open in the system browser, never in-app.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (isOwnOrigin(url)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  wc.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details.reason, details.exitCode)
    if (details.reason !== 'clean-exit') recoverRenderer(win)
  })

  if (!app.isPackaged) {
    wc.on('before-input-event', (e, input) => {
      const devtools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
      if (input.type === 'keyDown' && devtools) {
        wc.toggleDevTools()
        e.preventDefault()
      }
    })
  }

  win.loadURL(DEV_URL || `${APP_ORIGIN}/index.html`)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

// Chromium restarts a crashed GPU process by itself; the renderer's WebGL
// context-loss handlers (src/three/scene.js) do the visual recovery. Log for diagnosis.
app.on('child-process-gone', (_e, details) => {
  if (details.type === 'GPU') console.error('[gpu process gone]', details.reason, details.exitCode)
})

app.whenReady().then(() => {
  registerAppProtocol()
  hardenSession()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
