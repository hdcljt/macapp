/**
 * chromeView 专用 preload：只暴露 chrome.html 需要的最小 IPC API。
 *
 * 与 preload.ts 的区别：preload.ts 暴露给 offline-app / contentView / codingView 用
 * （包括 coding:open-tool 等）。chromeView 只关心"返回首页 / 窗口控件 / coding 激活状态"，
 * 独立 preload 让权限/接口边界更清晰。
 */
import { contextBridge, ipcRenderer } from 'electron';

// codingView 激活状态的订阅集合：返回 unsubscribe 让 chrome.html 在 Vite HMR 时清理
const codingActiveListeners = new Set<(active: boolean) => void>();
ipcRenderer.on('chrome:coding-active', (_e, active: boolean) => {
  for (const cb of codingActiveListeners) cb(active);
});

// maximize 状态变化：用于切换 max 按钮的图标（最大化 vs 还原）
const maxStateListeners = new Set<(maximized: boolean) => void>();
ipcRenderer.on('chrome:max-state', (_e, maximized: boolean) => {
  for (const cb of maxStateListeners) cb(maximized);
});

contextBridge.exposeInMainWorld('chromeAPI', {
  /** 主进程推 app 版本号 */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  /** 拉 codingView 当前激活状态（chrome.html 启动时调用，修竞态：
   *  若启动前 setCodingActive(true) 已经发过 IPC，listener 还没注册就丢了）。 */
  getCodingActive: (): Promise<boolean> => ipcRenderer.invoke('chrome:get-coding-active'),
  /** 主进程推 codingView 激活状态变化（true 显示返回首页按钮） */
  onCodingActiveChange: (cb: (active: boolean) => void): (() => void) => {
    codingActiveListeners.add(cb);
    return () => codingActiveListeners.delete(cb);
  },
  /** 主进程推窗口最大化/还原状态（用于切换 max 按钮图标） */
  onMaximizeStateChange: (cb: (maximized: boolean) => void): (() => void) => {
    maxStateListeners.add(cb);
    return () => maxStateListeners.delete(cb);
  },
  /** 通知主进程：用户点了"返回首页"按钮（coding:close 同效） */
  home: (): void => { ipcRenderer.send('chrome:home'); },
  minimize: (): void => { ipcRenderer.send('chrome:min'); },
  toggleMaximize: (): void => { ipcRenderer.send('chrome:max'); },
  close: (): void => { ipcRenderer.send('chrome:close'); },
});