const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atelierDesktop', {
  layout: (projectId, bounds) => ipcRenderer.send('browser:layout', { projectId, bounds }),
  command: (projectId, action, url) =>
    ipcRenderer.invoke('browser:command', { projectId, action, url }),
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => ipcRenderer.removeListener('browser:state', listener);
  },
});
