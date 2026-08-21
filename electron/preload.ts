import { contextBridge, ipcRenderer } from 'electron';

// 暴露给 splash / retry / error / updater 页面的 API
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    app: process.env.npm_package_version || 'unknown',
  },
  retry: () => ipcRenderer.send('retry:request'),
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.invoke('log:write', level, message);
  },
  updater: {
    /** 触发下载（用户点击「立即更新」后调用） */
    download: (): Promise<void> => ipcRenderer.invoke('updater:download'),
    /** 触发安装 + 退出应用（用户点击「立即安装」后调用） */
    install: (): Promise<void> => ipcRenderer.invoke('updater:install'),
    /** 用户点击「以后再说」（version 用于 dismiss 追踪） */
    dismiss: (version: string): Promise<void> => ipcRenderer.invoke('updater:dismiss', version),
    /** 订阅下载进度事件 */
    onProgress: (cb: (percent: number) => void): void => {
      ipcRenderer.on('updater:progress', (_e, pct: number) => cb(pct));
    },
    /** 订阅下载完成事件 */
    onDownloaded: (cb: () => void): void => {
      ipcRenderer.on('updater:downloaded', () => cb());
    },
    /** 订阅错误事件 */
    onError: (cb: (msg: string) => void): void => {
      ipcRenderer.on('updater:error', (_e, msg: string) => cb(msg));
    },
  },
});
