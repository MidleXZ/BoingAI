const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('boingWindow', {
  minimize: () => ipcRenderer.invoke('win:minimize'),
  maximize: () => ipcRenderer.invoke('win:maximize'),
  close: () => ipcRenderer.invoke('win:close'),
  fullscreen: () => ipcRenderer.invoke('win:fullscreen'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  isFullScreen: () => ipcRenderer.invoke('win:isFullScreen'),
});
