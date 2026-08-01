'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  selectFolder: (title) => ipcRenderer.invoke('dialog:selectFolder', title),
  listImages: (folder) => ipcRenderer.invoke('images:list', folder),
  folderTree: (root) => ipcRenderer.invoke('folders:tree', root),
  createFolder: (parent, name) => ipcRenderer.invoke('folders:create', parent, name),
  renameFolder: (folderPath, newName) => ipcRenderer.invoke('folders:rename', folderPath, newName),
  deleteFolder: (folderPath) => ipcRenderer.invoke('folders:delete', folderPath),
  moveFolder: (src, destParent) => ipcRenderer.invoke('folders:move', src, destParent),
  geocodeBatch: (coords) => ipcRenderer.invoke('geocode:batch', coords),
  trashFile: (src) => ipcRenderer.invoke('files:trash', src),
  untrashFile: (staged, orig) => ipcRenderer.invoke('files:untrash', staged, orig),
  commitTrash: () => ipcRenderer.invoke('trash:commit'),
  moveFiles: (list, dest) => ipcRenderer.invoke('files:move', list, dest),
  moveTo: (src, target) => ipcRenderer.invoke('files:moveTo', src, target),
  readMeta: (file) => ipcRenderer.invoke('meta:read', file),
  ensureGoodBad: (folder) => ipcRenderer.invoke('finesort:ensure', folder),
  createGoodBad: (folder) => ipcRenderer.invoke('finesort:createGoodBad', folder),
  mediaUrl: (p) => 'media://get/' + encodeURIComponent(p)
});
