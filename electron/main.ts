import { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// CJS 模式下 __dirname 是内置的；ESM 模式下需要用 import.meta.url
declare const __dirname: string;

import { loadConfig } from './config';
import type { LoadedConfig } from './config';
import { logger, initLogger, registerLogHandlers, closeLogger } from './logger';
import { initUpdater, checkForUpdates } from './updater';
import { CodingAgent, type CodingStatus } from './codingAgent';

let mainWindow: BrowserWindow | null = null;

// 当前可见的 Views 集合（offline-first 模式用 2 个：offlineView + contentView；
// legacy 模式用 4 个：loadingView + retryView + errorView + contentView）
let loadingView: WebContentsView | null = null;
let retryView: WebContentsView | null = null;
let errorView: WebContentsView | null = null;
let offlineView: WebContentsView | null = null; // offline-first 模式专用
let contentView: WebContentsView | null = null;
let codingView: WebContentsView | null = null; // v1.2 新增：内嵌编码工具 web UI

let retryCount = 0;
let loadFailed = false; // tracking：最近一次 URL 加载是否失败，避免 did-finish-load 覆盖 retry/error 视图
let offlineReady = false; // offline-first 模式：offlineView 的 renderer 是否已就绪（IPC 可用）
let codingAgent: CodingAgent | null = null; // v1.2 新增：编码工具进程管理器

const log = logger.child('main');

/** 同一时刻仅一个 View 可见；传入 null 表示隐藏全部 */
function showOnly(view: WebContentsView | null) {
  loadingView?.setVisible(view === loadingView);
  retryView?.setVisible(view === retryView);
  errorView?.setVisible(view === errorView);
  offlineView?.setVisible(view === offlineView);
  contentView?.setVisible(view === contentView);
  codingView?.setVisible(view === codingView);
}

/** 收集当前所有可见的 View 集合，用于 resize 同步 bounds */
function allViews(): WebContentsView[] {
  return [loadingView, retryView, errorView, offlineView, contentView, codingView].filter(
    (v): v is WebContentsView => v !== null,
  );
}

/**
 * offline-first 模式：向 offlineView 推「URL 加载状态」事件。
 * 安全发送：offlineView 销毁/未就绪时静默忽略。
 */
function emitLoadingState(state: 'show' | 'hide') {
  if (!offlineView || offlineView.webContents.isDestroyed()) return;
  if (!offlineReady) {
    log.debug(`offlineView not ready, drop loading:${state}`);
    return;
  }
  offlineView.webContents.send('online:loading', state);
}

/** 创建一个覆盖整个 mainWindow 的 WebContentsView，加载本地 HTML
 * @param htmlFile HTML 文件名（相对于 dist-electron/）
 * @param query 可选 query string 参数。sandboxed renderer 中 process.argv 不可靠，
 *              用 URL query string 传数据是 sandbox 安全的做法（参考 updater.ts）
 */
function createView(htmlFile: string, query?: Record<string, string>): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const [w, h] = mainWindow!.getContentSize();
  view.setBounds({ x: 0, y: 0, width: w, height: h });
  if (query && Object.keys(query).length > 0) {
    const fileUrl = pathToFileURL(path.join(__dirname, htmlFile));
    for (const [k, v] of Object.entries(query)) {
      fileUrl.searchParams.set(k, v);
    }
    view.webContents.loadURL(fileUrl.toString());
  } else {
    view.webContents.loadFile(path.join(__dirname, htmlFile));
  }
  mainWindow!.contentView.addChildView(view);
  view.setVisible(false);
  return view;
}

/** 创建一个覆盖整个 mainWindow 的 WebContentsView，加载 URL */
function createUrlView(url: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const [w, h] = mainWindow!.getContentSize();
  view.setBounds({ x: 0, y: 0, width: w, height: h });
  view.webContents.loadURL(url);
  mainWindow!.contentView.addChildView(view);
  view.setVisible(false);
  return view;
}

/**
 * codingView：加载内嵌编码工具的 web UI（v1.2 新增）
 * 独立 will-navigate 白名单 `http://127.0.0.1:<urlPort>/`，与 contentView 的
 * allowedOriginPrefix 无关（内嵌工具跑在 localhost 随机端口上）。
 */
function createCodingView(url: string): WebContentsView {
  const urlPort = new URL(url).port;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const [w, h] = mainWindow!.getContentSize();
  view.setBounds({ x: 0, y: 0, width: w, height: h });
  view.webContents.loadURL(url);

  view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (openUrl.startsWith('https:')) shell.openExternal(openUrl);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, navUrl) => {
    const allowed = `http://127.0.0.1:${urlPort}/`;
    if (!navUrl.startsWith(allowed)) {
      event.preventDefault();
      log.warn(`codingView will-navigate blocked: ${navUrl}`);
    }
  });

  mainWindow!.contentView.addChildView(view);
  view.setVisible(false);
  return view;
}

/** 显示 codingView：不存在则创建，已存在则复用并 loadURL（端口可能变了） */
function showCodingView(url: string): void {
  if (!codingView) codingView = createCodingView(url);
  else codingView.webContents.loadURL(url);
  showOnly(codingView);
}

/** 共用：创建 BrowserWindow 基础配置（两个模式共用） */
function createBaseWindow(config: LoadedConfig): BrowserWindow {
  const win = new BrowserWindow({
    width: config.width,
    height: config.height,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    // 统一使用原生标题栏（macOS 不再用 hiddenInset 沉浸式：业务需要显示标题栏）
    titleBarStyle: 'default',
    backgroundColor: '#FFFFFF',
    // 标题带版本号（任务栏一眼能看出当前版本）
    // 不用 app.getName()：dev 模式下它返回 npm「name」= macapp，不是 productName
    title: `算粒AI助手 v${app.getVersion()}`,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // 拦截 content 页通过 document.title 覆盖窗口标题
  win.on('page-title-updated', (event) => event.preventDefault());
  win.setMenuBarVisibility(false);
  return win;
}

/** 共用：给 contentView 绑定 will-navigate 拦截 + setWindowOpenHandler */
function attachContentViewCommonHandlers(allowedOriginPrefix: string) {
  if (!contentView) return;
  contentView.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  contentView.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedOriginPrefix)) {
      event.preventDefault();
      log.warn(`will-navigate blocked: ${url}`);
    }
  });
}

/** 共用：resize 同步 bounds */
function attachResizeHandler(win: BrowserWindow) {
  win.on('resize', () => {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    for (const v of allViews()) {
      v.setBounds({ x: 0, y: 0, width: w, height: h });
    }
  });
}

// =============================================================================
// 模式 A：offline-first（v0.6.0+，useOfflineFallback=true 默认）
// 启动立即显示 offlineView（本地 Vite 产物）→ 异步加载 contentView
// 成功 → 切到 contentView；失败/崩溃 → 留在 offlineView，TopBar「重新连接」可点
// =============================================================================
function createMainWindowOfflineFirst(config: LoadedConfig) {
  const isDev = !app.isPackaged;
  const TARGET_URL = config.targetUrl;
  const OFFLINE_PAGE = 'offline-app/index.html';
  log.info('view strategy: offline-first');

  mainWindow = createBaseWindow(config);
  offlineView = createView(OFFLINE_PAGE);
  contentView = createUrlView(TARGET_URL);

  // 等 offlineView 就绪后再发 IPC，否则事件丢失
  offlineView.webContents.once('did-finish-load', () => {
    offlineReady = true;
    log.info('offlineView did-finish-load, ready to receive IPC');
    emitLoadingState('show');
  });
  offlineView.webContents.once('did-fail-load', (_e, code, desc) => {
    log.error(`offlineView did-fail-load: ${code} ${desc} (兜底页本身加载失败，2s 后重试)`);
    setTimeout(() => {
      if (offlineView && !offlineView.webContents.isDestroyed()) {
        offlineView.webContents.reload();
      }
    }, 2000);
  });

  showOnly(offlineView);
  mainWindow.show();

  // contentView 事件：成功切到 contentView，失败/崩溃都只发 'hide'，view 不动
  contentView.webContents.on('did-finish-load', () => {
    if (loadFailed) {
      log.debug('content view did-finish-load but load was marked as failed, ignoring');
      return;
    }
    log.info('content view did-finish-load, switching to contentView');
    emitLoadingState('hide');
    showOnly(contentView);
  });
  contentView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    loadFailed = true;
    log.error(`content view did-fail-load: ${errorCode} ${errorDescription} url=${validatedURL}`);
    emitLoadingState('hide');
    // 留在 offlineView，不切 view
  });
  contentView.webContents.on('render-process-gone', (_event, details) => {
    log.error(`content view render-process-gone: ${JSON.stringify(details)}`);
    if (!contentView || contentView.webContents.isDestroyed()) return;
    emitLoadingState('hide');
    // 留在 offlineView，不切 view
  });

  attachContentViewCommonHandlers(config.allowedOriginPrefix);
  attachResizeHandler(mainWindow);

  // IPC handlers (retry:request / online:retry) are registered once at app startup
  // by registerIpcHandlers(), not here — see Bug 4 fix in code-review.

  mainWindow.on('closed', () => {
    mainWindow = null;
    offlineView = null;
    contentView = null;
    codingView = null; // v1.2: 随窗口销毁，否则 showOnly 会碰到已销毁的 view
    offlineReady = false;
    loadFailed = false;
  });

  if (isDev) {
    // 故意挂到 contentView 而非 offlineView：
    // - detach 模式下 DevTools 窗口独立显示，用户切换 view 时需要 DevTools 跟随正在看的页面
    // - online 页才是开发调试的主要目标（offlineView 是本地 Vite 产物，出问题直接看 DevTools 也行）
    // - 同一 process 反复创建 WebContentsView 时，先挂的 DevTools 会随 view 销毁 → 挂到 contentView 保证生存期最长
    contentView.webContents.openDevTools({ mode: 'detach' });
  }
}

// =============================================================================
// 模式 B：legacy（v0.5.6 行为，useOfflineFallback=false）
// 启动显示 splash → 加载 contentView
// 成功 → 切到 contentView；失败 → retryView 重试 N 次 → errorView
// =============================================================================
function createMainWindowLegacy(config: LoadedConfig) {
  const isDev = !app.isPackaged;
  const TARGET_URL = config.targetUrl;
  const MAX_RETRIES = config.maxRetries;
  const RETRY_DELAY_MS = config.retryDelayMs;
  log.info('view strategy: legacy (splash → retry → error)');

  mainWindow = createBaseWindow(config);
  loadingView = createView('splash.html');
  retryView = createView('retry.html');
  // errorView 需要展示 targetUrl 给用户（提示哪个服务连不上）
  errorView = createView('error.html', { targetUrl: TARGET_URL });
  contentView = createUrlView(TARGET_URL);

  showOnly(loadingView);
  mainWindow.show();

  /**
   * legacy 模式重试逻辑（合并自 did-fail-load / render-process-gone 两个 handler）。
   * @param reason 失败原因（用于日志区分）
   */
  function attemptLegacyRetry(reason: string) {
    if (retryCount >= MAX_RETRIES) {
      log.error(`gave up after ${MAX_RETRIES} retries (${reason}), switching to error view`);
      showOnly(errorView);
      return;
    }
    retryCount += 1;
    log.warn(`retry ${retryCount}/${MAX_RETRIES} (${reason})`);
    retryView?.webContents.executeJavaScript(
      `document.querySelector('.label').textContent = '正在重试 ${retryCount}/${MAX_RETRIES}…';`,
    );
    showOnly(retryView);
    setTimeout(() => {
      loadFailed = false;
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.reload();
      }
    }, RETRY_DELAY_MS);
  }

  // contentView 事件：失败 → retryView 重试 N 次 → errorView
  contentView.webContents.on('did-finish-load', () => {
    if (loadFailed) {
      log.debug('content view did-finish-load but load was marked as failed, ignoring');
      return;
    }
    log.info('content view did-finish-load, switching to contentView');
    showOnly(contentView);
  });
  contentView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    loadFailed = true;
    log.error(`content view did-fail-load: ${errorCode} ${errorDescription} url=${validatedURL}`);
    attemptLegacyRetry('did-fail-load');
  });
  contentView.webContents.on('render-process-gone', (_event, details) => {
    log.error(`content view render-process-gone: ${JSON.stringify(details)}`);
    if (!contentView || contentView.webContents.isDestroyed()) return;
    attemptLegacyRetry('render-process-gone');
  });

  attachContentViewCommonHandlers(config.allowedOriginPrefix);
  attachResizeHandler(mainWindow);

  // IPC handlers (retry:request / online:retry) are registered once at app startup
  // by registerIpcHandlers(), not here — see Bug 4 fix in code-review.

  mainWindow.on('closed', () => {
    mainWindow = null;
    loadingView = null;
    retryView = null;
    errorView = null;
    contentView = null;
    codingView = null; // v1.2: 随窗口销毁，否则 showOnly 会碰到已销毁的 view
    retryCount = 0;
    loadFailed = false;
  });

  if (isDev) {
    contentView.webContents.openDevTools({ mode: 'detach' });
  }
}

function createMainWindow(config: LoadedConfig) {
  if (config.useOfflineFallback) {
    createMainWindowOfflineFirst(config);
  } else {
    createMainWindowLegacy(config);
  }
}

/**
 * 注册 IPC handlers（启动时一次性注册，避免 macOS activate 后多次 createMainWindow
 * 导致 handler 累积泄漏）。
 *
 * 模式条件注册：
 * - legacy：仅注册 `retry:request`（error.html 重试按钮触发），不注册 `online:retry`
 * - offline-first：仅注册 `online:retry`（offlineView TopBar 重连触发），不注册 `retry:request`
 *
 * 原因（Q3 + Q4）：offline-first 不创建 errorView，legacy 不创建 offlineView，
 * 对应 handler 在对方模式下永远不会触发，注册纯浪费。
 *
 * coding:* handlers（v1.2）两个模式共用，无条件注册；需要 config 读 codingAgent.tools。
 */
function registerIpcHandlers(mode: 'offline-first' | 'legacy', config: LoadedConfig) {
  if (mode === 'legacy') {
    // error.html 「重试」按钮 → 完全重置 retryCount
    ipcMain.on('retry:request', () => {
      log.info('user triggered retry from error view');
      retryCount = 0;
      loadFailed = false;
      showOnly(loadingView);
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.reload();
      }
    });
  } else {
    // offlineView TopBar「重新连接」→ 推 loading:show 给 spinner
    ipcMain.on('online:retry', () => {
      log.info('user triggered retry from offline view TopBar');
      loadFailed = false;
      emitLoadingState('show');
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.reload();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // v1.2: coding handlers（两个模式共用）
  // ---------------------------------------------------------------------------

  /** renderer 拉工具列表（渲染 ToolPickerDialog） */
  ipcMain.handle('coding:list-tools', () => config.codingAgent.tools);

  /** 弹原生目录选择 dialog；取消返回 null */
  ipcMain.handle('coding:choose-directory', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择项目目录',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /** 打开工具：external detached 唤起；embedded spawn + 主进程主动切 codingView */
  ipcMain.handle('coding:open-tool', async (_e, toolId: string, dir: string) => {
    if (!codingAgent) {
      return { ok: false, reason: 'spawn-failed', message: 'codingAgent 未初始化' };
    }
    const tool = config.codingAgent.tools.find((t) => t.id === toolId);
    if (!tool) {
      return { ok: false, reason: 'unknown-tool', message: `未找到工具: ${toolId}` };
    }
    const result = await codingAgent.openTool(tool, dir);
    // view 切换由主进程独占：embedded 就绪后主动加载 url
    if (result.ok && result.url && tool.type === 'embedded') {
      showCodingView(result.url);
    }
    return result;
  });

  /** 关闭内嵌 view，切回 offlineView（legacy 模式 fallback contentView） */
  ipcMain.on('coding:close', () => {
    log.info('user triggered close coding view');
    showOnly(offlineView ?? contentView);
  });

  /** renderer 启动时拉初始状态 */
  ipcMain.handle('coding:status', () => codingAgent?.getStatus() ?? { state: 'idle' });
}

// loadConfig() 是 async（内部调 app.getPath('userData')），esbuild CJS 拒绝顶层 await，故在 whenReady 内 await
app.whenReady().then(async () => {
  initLogger();
  log.info('app ready');
  registerLogHandlers();
  const config = await loadConfig();
  log.info(`config loaded: ${config.width}x${config.height}`);
  registerIpcHandlers(config.useOfflineFallback ? 'offline-first' : 'legacy', config);
  // v1.2: codingAgent 必须在 registerIpcHandlers 之后创建 —— handler 闭包读的是
  // 模块级 codingAgent 变量，subscribe 推送到所有 BrowserWindow（renderer 侧 toast）
  codingAgent = new CodingAgent(config.codingAgent);
  codingAgent.subscribe((status: CodingStatus) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('coding:status', status);
    }
  });
  createMainWindow(config);
  log.info(`createMainWindow end: ${config.width}x${config.height}`);

  // 主窗口已显示后再启动 updater，任何异常都不能影响主流程
  setImmediate(() => {
    try {
      initUpdater({
        autoUpdate: config.autoUpdate,
        updateChannel: config.updateChannel,
        dismissCooldownHours: config.dismissCooldownHours,
      });
      checkForUpdates();
    } catch (err) {
      log.error(`updater init failed: ${(err as Error).message}`);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(config);
    }
  });
});

app.on('before-quit', () => {
  log.info('app quitting');
  // 先 kill 内嵌子进程（同步返回，SIGKILL 兜底 2s 异步），再关日志文件
  codingAgent?.shutdown();
  closeLogger();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
