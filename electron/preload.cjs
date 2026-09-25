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

  // Basename of a path, for display (e.g. Recent Projects list).
  baseName: (path) => ipcRenderer.invoke('animare:base-name', path),
})
