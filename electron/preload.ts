import { contextBridge, ipcRenderer } from 'electron';

// 暴露给 splash / retry / error / updater / offline 页面的 API
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    // app 版本号经 IPC 取（process.env.npm_package_version 在打包后丢失）
    app: (): Promise<string> => ipcRenderer.invoke('app:version'),
  },
  retry: () => ipcRenderer.send('retry:request'),
  /**
   * 订阅主进程推送的「URL 加载状态」。
   * - 'show'：正在尝试连接在线服务（offline 页应显示加载 toast）
   * - 'hide'：连接结束（成功 → 切到 contentView；失败 → 留在 offline 页）
   */
  onLoadingStateChange: (cb: (state: 'show' | 'hide') => void): void => {
    ipcRenderer.on('online:loading', (_e, state: 'show' | 'hide') => cb(state));
  },
  /**
   * 用户点击 offline 页 TopBar 的「重新连接」→ 通知主进程重试。
   * 主进程会发 'show' → reload → 走原有成功/失败路径。
   */
  retryOnline: (): void => {
    ipcRenderer.send('online:retry');
  },
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
