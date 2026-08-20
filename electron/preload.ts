import { contextBridge, ipcRenderer } from 'electron';

// 暴露给 splash / retry / error 页面的 API
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  retry: () => ipcRenderer.send('retry:request'),
});
