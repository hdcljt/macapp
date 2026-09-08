/**
 * window.electronAPI 全局类型声明
 *
 * preload.ts 通过 contextBridge.exposeInMainWorld 暴露 electronAPI 命名空间。
 * renderer 侧代码访问 window.electronAPI.* 时需要类型约束。
 *
 * 与 electron/preload.ts 一一对应；若 preload 改 schema 必须同步这里。
 *
 * 不存在（dev 模式 / 浏览器单独跑）时为 undefined，调用方需做存在性检查。
 */

export {};

export interface ElectronAPIUpdater {
  download(): Promise<void>;
  install(): Promise<void>;
  dismiss(version: string): Promise<void>;
  onProgress(cb: (percent: number) => void): void;
  onDownloaded(cb: () => void): void;
  onError(cb: (msg: string) => void): void;
}

export interface ElectronAPICoding {
  listTools(): Promise<unknown[]>;
  openTool(
    toolId: string,
  ): Promise<{ ok: boolean; url?: string; reason?: string; message?: string }>;
  chooseDirectory(): Promise<string | null>;
  close(): void;
  onStatus(cb: (status: unknown) => void): () => void;
  getInitialStatus(): Promise<unknown>;
}

export interface ElectronAPI {
  platform: NodeJS.Platform;
  versions: {
    node: string;
    chrome: string;
    electron: string;
    app(): Promise<string>;
  };
  retry(): void;
  onLoadingStateChange(cb: (state: 'show' | 'hide') => void): () => void;
  retryOnline(): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): Promise<unknown>;
  updater: ElectronAPIUpdater;
  coding: ElectronAPICoding;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
