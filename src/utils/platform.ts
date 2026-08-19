/**
 * 平台检测工具
 * 在 Electron 环境下从 preload 获取 platform
 * 在浏览器开发环境下使用 navigator.platform
 */
export function getPlatform(): NodeJS.Platform | 'browser' {
  if (typeof window !== 'undefined' && window.electronAPI?.platform) {
    return window.electronAPI.platform;
  }
  // 浏览器或开发环境兜底
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac')) return 'darwin';
    if (ua.includes('win')) return 'win32';
    return 'linux';
  }
  return 'browser';
}

export const isMac = (): boolean => getPlatform() === 'darwin';
