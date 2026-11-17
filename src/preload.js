const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lotus', {
  loadProject: () => ipcRenderer.invoke('project:load'),
  saveProject: (data) => ipcRenderer.invoke('project:save', data),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  get: (url, accept) => ipcRenderer.invoke('net:get', url, accept),
  extract: (text) => ipcRenderer.invoke('ai:extract', text),
  difyRetrieve: (query, override) => ipcRenderer.invoke('dify:retrieve', query, override),
  difySync: (items) => ipcRenderer.invoke('dify:sync', items),
  difyExtract: (text) => ipcRenderer.invoke('dify:extract', text),
  open: (url) => ipcRenderer.invoke('shell:open', url),
  cacheStats: () => ipcRenderer.invoke('cache:stats'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  files: {
    prepare: (title, folder) => ipcRenderer.invoke('files:prepare', title, folder),
    sync: (dir, chapters, world) => ipcRenderer.invoke('files:sync', dir, chapters, world),
    choose: () => ipcRenderer.invoke('files:choose'),
    reveal: (dir) => ipcRenderer.invoke('files:reveal', dir),
  },
  git: {
    status: (dir) => ipcRenderer.invoke('git:status', dir),
    commit: (dir, message) => ipcRenderer.invoke('git:commit', dir, message),
    switch: (dir, name) => ipcRenderer.invoke('git:switch', dir, name),
    create: (dir, name) => ipcRenderer.invoke('git:create', dir, name),
    remove: (dir, name) => ipcRenderer.invoke('git:delete', dir, name),
  },
  onFlush: (fn) => ipcRenderer.on('app:flush', async () => {
    await fn();
    ipcRenderer.send('app:flushed');
  }),
});
