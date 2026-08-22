/**
 * 把渲染端 console 输出转发到主进程日志文件
 *
 * 设计要点：
 * - 包装 console.{debug, info, log, warn, error} 5 个方法
 * - 先调原 console（保留 DevTools 输出），再异步发 IPC 到主进程
 * - 主进程 logger.ts:141-151 的 'log:write' handler 写到 userData/logs/main.log，模块名标记为 renderer
 * - dev 模式（window.electronAPI 不存在）静默跳过，不影响浏览器 DevTools 输出
 * - IPC 失败静默忽略，不影响应用运行
 * - 多参数格式化：string 直传、Error 用 name+message、其他尝试 JSON.stringify 失败回退 String()
 * - console.log / console.info 都映射到 info 级别（与主进程 logger 约定一致）
 *
 * 使用：在应用入口（main.ts）最顶部 import 该模块即可
 *   import './electron-logger-bridge';
 *
 * 注意：必须在所有其他 import 之后立即调用（脚本顶层 IIFE 立即执行）。
 *      Vue/Pinia/Element Plus 顶层 module 加载期间的 console 输出不会被捕获
 *      （运行时它们调用的 console.log 会被拦截）
 */

/**
 * 把 console.* 的多参数数组序列化成单行字符串
 * - string 原样
 * - Error 用 `Name: message`
 * - 其他尝试 JSON.stringify，循环引用等失败回退 String()
 *
 * 导出供 smoke test 验证
 */
export function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/**
 * 把原 console 的 5 个方法替换成「先调原 console + 异步转发 IPC」的版本
 * - api：window.electronAPI（必须有 log 方法，否则函数体直接 return）
 *
 * 导出供测试和未来调用方
 */
export function wrapConsole(api: { log(level: string, message: string): Promise<unknown> }): void {
  const originalDebug = console.debug.bind(console);
  const originalInfo = console.info.bind(console);
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  const forward = (
    level: 'debug' | 'info' | 'warn' | 'error',
    args: unknown[],
  ): void => {
    try {
      const message = formatArgs(args);
      // 不 await：IPC 失败不影响应用，也不阻塞 console 调用
      api.log(level, message).catch(() => {
        // 静默：转发失败不影响用户
      });
    } catch {
      // 静默：formatArgs 失败也不影响用户
    }
  };

  console.debug = (...args: unknown[]): void => {
    originalDebug(...args);
    forward('debug', args);
  };
  console.info = (...args: unknown[]): void => {
    originalInfo(...args);
    forward('info', args);
  };
  console.log = (...args: unknown[]): void => {
    originalLog(...args);
    forward('info', args); // console.log → info 级别
  };
  console.warn = (...args: unknown[]): void => {
    originalWarn(...args);
    forward('warn', args);
  };
  console.error = (...args: unknown[]): void => {
    originalError(...args);
    forward('error', args);
  };
}

// IIFE：检测环境后立即包装 console
(function setupConsoleForwarding() {
  if (typeof window === 'undefined') return;
  const api = window.electronAPI;
  if (!api || typeof api.log !== 'function') return;
  wrapConsole(api);
})();
