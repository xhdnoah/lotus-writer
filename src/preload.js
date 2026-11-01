const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lotus', {
  loadProject: () => ipcRenderer.invoke('project:load'),
  saveProject: (data) => ipcRenderer.invoke('project:save', data),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  get: (url, accept) => ipcRenderer.invoke('net:get', url, accept),
  extract: (text) => ipcRenderer.invoke('ai:extract', text),
  open: (url) => ipcRenderer.invoke('shell:open', url),
  cacheStats: () => ipcRenderer.invoke('cache:stats'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
});
