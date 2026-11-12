'use strict'
// Preload bridge — exposes a small native "open/save/read/write a real file
// on disk" API to the renderer as window.animare. This exists because the
// browser File System Access API's handles (window.showOpenFilePicker /
// showSaveFilePicker) lose their permission grant across app restarts in
// Chromium/Electron, throwing "Failed to execute 'getFile' on
// 'FileSystemFileHandle': The request is not allowed..." the moment a
// "Recent Projects/Clips" entry saved from a previous session is reopened.
// Native dialogs + plain fs paths never expire, so projectStore.js /
// clipLibrary.js use this instead of the web picker whenever it's present,
// falling back to the browser API on the hosted/itch.io build where this
// bridge doesn't exist.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('animare', {
  isElectron: true,

  // opts: { filters: [{ name, extensions }] }
  // Returns null if the user cancels.
  pickOpenFile: (opts) => ipcRenderer.invoke('animare:pick-open-file', opts),

  // opts: { filters: [{ name, extensions }], suggestedName }
  // Returns null if the user cancels.
  pickSaveFile: (opts) => ipcRenderer.invoke('animare:pick-save-file', opts),

  // Reads a file at `path` as a UTF-8 string.
  readFile: (path) => ipcRenderer.invoke('animare:read-file', path),

  // Writes a UTF-8 string to `path`, creating/overwriting it.
  writeFile: (path, contents) => ipcRenderer.invoke('animare:write-file', path, contents),

  // Native confirm (OK / Cancel) shown by the main process → true when OK was chosen. Synchronous, so it can
  // stand in for window.confirm, which leaves the window half focused (dead <select> popups) after it closes.
  confirm: (message) => ipcRenderer.sendSync('animare:confirm', String(message ?? '')),

  // Hand keyboard focus back to the page contents after a native dialog (never moves the window itself).
  refocusWindow: () => ipcRenderer.send('animare:refocus'),

  // Basename of a path, for display (e.g. Recent Projects list).
  baseName: (path) => ipcRenderer.invoke('animare:base-name', path),

  // Opening a .3dcp from the OS (double-click / "Open with" / second launch).
  // takePendingOpenFile() → the path the app was launched with, or null; call it once on startup.
  takePendingOpenFile: () => ipcRenderer.invoke('animare:take-pending-open'),
  // onOpenFile(cb) → calls cb(path) when a file is opened while the app is already running.
  // Returns an unsubscribe function.
  onOpenFile: (cb) => {
    const handler = (_e, filePath) => cb(filePath)
    ipcRenderer.on('animare:open-file', handler)
    return () => ipcRenderer.removeListener('animare:open-file', handler)
  },

  // Closing the window: main asks the renderer first (so it can offer to save).
  // onCloseRequested(cb) → cb() when the person tries to close; returns an unsubscribe function.
  // Call closeAck() straight away (it proves the page is alive), then closeNow() once closing is fine.
  onCloseRequested: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('animare:close-requested', handler)
    return () => ipcRenderer.removeListener('animare:close-requested', handler)
  },
  closeAck: () => ipcRenderer.send('animare:close-ack'),
  closeNow: () => ipcRenderer.send('animare:close-now'),

  // .blend import: runs the user's own Blender, headless, to convert the file to glTF.
  blender: {
    // → { available, path, source, version, tooOld }
    status: () => ipcRenderer.invoke('animare:blender-status'),
    // Native "find blender.exe" dialog; remembered. → status (plus `error` if it wasn't Blender)
    choose: () => ipcRenderer.invoke('animare:blender-choose'),
    // Forget the chosen path and go back to auto-detecting.
    clear: () => ipcRenderer.invoke('animare:blender-clear'),
    // payload: { main, files: [{ path, data }] } → { ok, glb, warnings } | { ok:false, error, code }
    convert: (payload) => ipcRenderer.invoke('animare:blender-convert', payload),
  },

  // Pose Finder (video -> mocap): runs Meta's SAM 3D Body locally through onnxruntime-node (see poseEngine.cjs).
  pose: {
    // → { ortOk, ortError, modelReady, modelBytes, expectedBytes, modelPath, licenseUrl, loaded, provider, platform, arch }
    status: () => ipcRenderer.invoke('animare:pose-status'),
    // One-time ~1.4 GB model download. → { ok } | { ok:false, error }
    download: () => ipcRenderer.invoke('animare:pose-download'),
    cancelDownload: () => ipcRenderer.invoke('animare:pose-download-cancel'),
    onDownloadProgress: (cb) => {
      const handler = (_e, p) => cb(p)
      ipcRenderer.on('animare:pose-download-progress', handler)
      return () => ipcRenderer.removeListener('animare:pose-download-progress', handler)
    },
    // pref: 'auto' | 'cpu' | 'dml' → { ok, provider, loadMs } | { ok:false, error }
    load: (pref) => ipcRenderer.invoke('animare:pose-load', pref),
    unload: () => ipcRenderer.invoke('animare:pose-unload'),
    // One person crop → { ok, out:{ keypoints_2d, keypoints_3d, cam_t, joint_coords, joint_rotations, ms } } | { ok:false, error }
    infer: (payload) => ipcRenderer.invoke('animare:pose-infer', payload),
  },
})
