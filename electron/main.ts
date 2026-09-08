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
let chromeView: WebContentsView | null = null; // 自定义标题栏浮层（v1.2+：返回首页 + 窗口控件）

/** chromeView 高度（px）。 所有非 chrome view 都从 y=CHROME_HEIGHT 开始布局。 */
const CHROME_HEIGHT = 32;

let retryCount = 0;
let loadFailed = false; // tracking：最近一次 URL 加载是否失败，避免 did-finish-load 覆盖 retry/error 视图
let offlineReady = false; // offline-first 模式：offlineView 的 renderer 是否已就绪（IPC 可用）
let codingAgent: CodingAgent | null = null; // v1.2 新增：编码工具进程管理器

const log = logger.child('main');

/** 同一时刻仅一个 View 可见；传入 null 表示隐藏全部
 * chromeView 始终保持可见（自定义标题栏要盖在所有 view 顶部），
 * 不参与排他显隐——只有 setCodingActive 推送状态让 chrome.html 决定是否显示「返回首页」按钮。
 */
function showOnly(view: WebContentsView | null) {
  loadingView?.setVisible(view === loadingView);
  retryView?.setVisible(view === retryView);
  errorView?.setVisible(view === errorView);
  offlineView?.setVisible(view === offlineView);
  contentView?.setVisible(view === contentView);
  codingView?.setVisible(view === codingView);
  chromeView?.setVisible(true);
}

/** 收集当前所有可见的 View 集合，用于 resize 同步 bounds */
function allViews(): WebContentsView[] {
  return [loadingView, retryView, errorView, offlineView, contentView, codingView, chromeView].filter(
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

/**
 * 设置一个内容 view 的 bounds：跳过顶部 chromeView 占据的 CHROME_HEIGHT 像素。
 * 必须在 view 创建时就调（不能等 resize 事件）—— 否则首帧渲染时 view 会盖住 chromeView，
 * 看起来像"标题栏把内容遮住了"，resize 后才会自动修复（用户报告"经常出现"就是这个原因）。
 */
function setViewContentBounds(view: WebContentsView): void {
  const [w, h] = mainWindow!.getContentSize();
  view.setBounds({
    x: 0,
    y: CHROME_HEIGHT,
    width: w,
    height: Math.max(0, h - CHROME_HEIGHT),
  });
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
  setViewContentBounds(view);
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
  setViewContentBounds(view);
  view.webContents.loadURL(url);
  mainWindow!.contentView.addChildView(view);
  view.setVisible(false);
  return view;
}

/**
 * codingView：加载内嵌编码工具的 web UI（v1.2 新增）
 * will-navigate 白名单按 origin（new URL(url).origin）限定：
 * - embedded http://127.0.0.1:<port>/
 * - url 类型 https://<host>/（任意公网域名，按用户配置信任）
 * 与 contentView 的 allowedOriginPrefix 无关。
 *
 * 切工具 origin 变化时由 showCodingView destroy+重建 codingView，
 * 新建实例的 will-navigate 白名单跟随新 origin（白名单不跨实例累积）。
 */
function createCodingView(url: string): WebContentsView {
  const urlOrigin = new URL(url).origin;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  setViewContentBounds(view);
  view.webContents.loadURL(url);

  view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    if (openUrl.startsWith('https:')) shell.openExternal(openUrl);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, navUrl) => {
    // startsWith 前缀匹配：同 origin 所有路径（含 query/hash）都放行
    if (!navUrl.startsWith(urlOrigin + '/') && navUrl !== urlOrigin) {
      event.preventDefault();
      log.warn(`codingView will-navigate blocked: ${navUrl} (allowed origin: ${urlOrigin})`);
    }
  });
  // loadURL 失败兜底：url 类型没 spawn 阶段，靠 did-fail-load 检测加载失败；
  // 失败 → 切回 offlineView + 发 error toast（renderer 侧 coding-toast 已有 spawn-failed 通道，
  // 此处不重新发明，直接走 ipcMain 通知 offline-app）。
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error(`codingView did-fail-load: ${errorCode} ${errorDescription} url=${validatedURL}`);
    if (codingView === view && mainWindow && !mainWindow.isDestroyed()) {
      setCodingActive(false);
      showOnly(offlineView ?? contentView);
      // 通知 renderer 弹错误 toast
      mainWindow.webContents.send('coding:status', {
        state: 'spawn-failed',
        message: `加载失败：${errorDescription} (${errorCode})`,
      });
    }
  });

  mainWindow!.contentView.addChildView(view);
  view.setVisible(false);
  // 把 chromeView 重新提到最上层：codingView 是延迟创建的（首次 showCodingView 才 addChildView），
  // addChildView 会把它加到 children 末尾，盖在 chromeView 上 → 标题栏消失。
  // WebContentsView.addChildView 对已存在的子 view 会把它移到末尾（置顶）。
  if (chromeView) mainWindow!.contentView.addChildView(chromeView);
  return view;
}

/**
 * 销毁当前 codingView（切到不同 origin 工具时调用，让白名单跟随新 origin）。
 *  - removeChildView 把 view 从窗口摘掉，WebContentsView 的渲染进程随之释放
 *  - codingView 置 null，下次 showCodingView 会重新 createCodingView
 *  - 注：WebContents 类型没有公开 destroy() 方法（Electron 内部用），仅 removeChildView + GC
 */
function destroyCodingView(): void {
  if (!codingView || !mainWindow || mainWindow.isDestroyed()) {
    codingView = null;
    return;
  }
  try {
    mainWindow.contentView.removeChildView(codingView);
  } catch (err) {
    log.warn(`removeChildView(codingView) threw: ${(err as Error).message}`);
  }
  codingView = null;
}

/** 显示 codingView：origin 变化时 destroy+重建（同 origin 复用 + loadURL） */
function showCodingView(url: string): void {
  const newOrigin = new URL(url).origin;
  const currentOrigin = codingView
    ? new URL(codingView.webContents.getURL()).origin
    : null;
  if (codingView && currentOrigin && currentOrigin !== newOrigin) {
    log.info(`showCodingView: origin ${currentOrigin} → ${newOrigin}, destroy + recreate`);
    destroyCodingView();
  }
  if (!codingView) codingView = createCodingView(url);
  else codingView.webContents.loadURL(url);
  showOnly(codingView);
  setCodingActive(true);
}

/** 是否处于 codingView（用于 chromeView 显示/隐藏「返回首页」按钮） */
let isCodingActive = false;

/** 设置并推送给 chromeView。codingView 状态变化时调用，保证 chrome.html 按钮可见性同步。
 * 安全发送：chromeView 可能为 null（窗口销毁中）或未就绪，静默忽略。 */
function setCodingActive(active: boolean): void {
  if (isCodingActive === active) return;
  isCodingActive = active;
  if (!chromeView || chromeView.webContents.isDestroyed()) return;
  chromeView.webContents.send('chrome:coding-active', active);
}

/** 推送窗口最大化状态给 chromeView：max 按钮需要切换图标（最大化 ↔ 还原）。
 * 注册时机：createBaseWindow 里给每个新窗口注册 maximize/unmaximize 监听（macOS activate
 * 可能多次 createMainWindow，每个新窗口都要单独注册）。 */
function pushMaxState(maximized: boolean): void {
  if (!chromeView || chromeView.webContents.isDestroyed()) return;
  chromeView.webContents.send('chrome:max-state', maximized);
}

/**
 * chromeView：自定义标题栏浮层（CHROME_HEIGHT 高，始终在顶部）
 * 独立 chrome-preload.js 暴露 window.chromeAPI 给 chrome.html 用。
 * 无 sandbox（IPC 不需要 sandbox）；contextIsolation 仍开启避免污染全局。
 */
function createChromeView(): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'chrome-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const [w] = mainWindow!.getContentSize();
  view.setBounds({ x: 0, y: 0, width: w, height: CHROME_HEIGHT });
  view.webContents.loadFile(path.join(__dirname, 'chrome.html'));
  // 最后 addChildView → WebContentsView 顺序上 chromeView 永远在最上层
  mainWindow!.contentView.addChildView(view);
  view.setVisible(true);
  return view;
}

/** 共用：创建 BrowserWindow 基础配置（两个模式共用） */
function createBaseWindow(config: LoadedConfig): BrowserWindow {
  const win = new BrowserWindow({
    width: config.width,
    height: config.height,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    // 自定义标题栏（chromeView）：隐藏原生标题栏，避免与 chromeView 重复占用顶部高度。
    // 窗口仍可拖动（chrome.html 用 -webkit-app-region: drag），窗口控件由 chromeView 提供。
    titleBarStyle: 'hidden',
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
  // 推送窗口最大化状态给 chromeView（max 按钮切换图标）
  win.on('maximize', () => pushMaxState(true));
  win.on('unmaximize', () => pushMaxState(false));
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

/** 共用：resize 同步 bounds
 * chromeView 占顶部 32px；其余 view 从 y=CHROME_HEIGHT 开始、height = totalHeight - CHROME_HEIGHT。
 * Math.max(0, h - CHROME_HEIGHT) 防止窗口最小化瞬间 totalHeight 极小导致负高度 setBounds 报错。
 */
function attachResizeHandler(win: BrowserWindow) {
  win.on('resize', () => {
    if (!win || win.isDestroyed()) return;
    for (const v of allViews()) {
      if (v === chromeView) {
        const [w] = win.getContentSize();
        v.setBounds({ x: 0, y: 0, width: w, height: CHROME_HEIGHT });
      } else {
        setViewContentBounds(v);
      }
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
    chromeView = null;
    isCodingActive = false;
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

  // 最后创建 chromeView（addChildView 顺序：后添加的在上层 → chromeView 永远在最上）
  chromeView = createChromeView();
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
    chromeView = null;
    isCodingActive = false;
    retryCount = 0;
    loadFailed = false;
  });

  if (isDev) {
    contentView.webContents.openDevTools({ mode: 'detach' });
  }

  // 最后创建 chromeView（addChildView 顺序：后添加的在上层 → chromeView 永远在最上）
  chromeView = createChromeView();
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
    try {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: '选择项目目录',
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    } catch (err) {
      log.error(`coding:choose-directory failed: ${(err as Error).message}`);
      return null;
    }
  });

  /** 打开工具：external detached 唤起；embedded spawn + 主进程主动切 codingView
   * dir 由主进程自己定（renderer 是 sandboxed 不能用 process.cwd()） */
  ipcMain.handle('coding:open-tool', async (_e, toolId: string) => {
    try {
      if (!codingAgent) {
        return { ok: false, reason: 'spawn-failed', message: 'codingAgent 未初始化' };
      }
      const tool = config.codingAgent.tools.find((t) => t.id === toolId);
      if (!tool) {
        return { ok: false, reason: 'unknown-tool', message: `未找到工具: ${toolId}` };
      }
      const result = await codingAgent.openTool(tool, process.cwd());
      // view 切换由主进程独占：embedded 就绪后、url 类型直接加载，都调 showCodingView
      if (result.ok && result.url && (tool.type === 'embedded' || tool.type === 'url')) {
        showCodingView(result.url);
      }
      return result;
    } catch (err) {
      const message = (err as Error).message;
      log.error(`coding:open-tool failed: ${message}`);
      return { ok: false, reason: 'spawn-failed', message };
    }
  });

  /** 关闭内嵌 view，切回 offlineView（legacy 模式 fallback contentView）
   * 同时立即 shutdown codingAgent —— 用户语义"退出工具"=杀 child + 释放端口，
   * 不应该延迟到下次切换工具才杀（用户报告"再次进入才释放"的体验问题）。 */
  ipcMain.on('coding:close', () => {
    log.info('user triggered close coding view');
    codingAgent?.shutdown();
    setCodingActive(false);
    showOnly(offlineView ?? contentView);
  });

  // =============================================================================
  // chromeView IPC：自定义标题栏的按钮事件（min/max/close + 返回首页）
  // 跟 native window 同语义，但走 HTML 按钮（titleBarStyle:hidden 下原生按钮没了）
  // =============================================================================

  /** 「← 返回首页」按钮：等价于 coding:close，回到 offlineView + 立即 shutdown codingAgent。 */
  ipcMain.on('chrome:home', () => {
    log.info('user clicked home from chrome view');
    if (isCodingActive) {
      codingAgent?.shutdown();
      setCodingActive(false);
      showOnly(offlineView ?? contentView);
    }
    // 非 coding 状态点 home 视为 no-op，避免误切 view
  });

  /** chrome.html 启动时拉一次 codingView 当前状态，修竞态：
   *  setCodingActive(true) 可能在 chrome-preload listener 注册前就发了 IPC，
   *  此时 push 消息丢失 → 必须靠 getCodingActive() 主动拉取。 */
  ipcMain.handle('chrome:get-coding-active', () => isCodingActive);

  ipcMain.on('chrome:min', () => {
    log.debug('user clicked minimize from chrome view');
    mainWindow?.minimize();
  });

  ipcMain.on('chrome:max', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on('chrome:close', () => {
    log.debug('user clicked close from chrome view');
    mainWindow?.close();
  });

  /** renderer 启动时拉初始状态 */
  ipcMain.handle('coding:status', async () =>
    codingAgent
      ? await codingAgent.getInitialStatus()
      : { state: 'idle' as const },
  );
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
  // 模块级 codingAgent 变量。subscribe 推送目标必须遍历 WebContentsView 子视图：
  // mainWindow 自身从不 loadFile/loadURL（所有页面都跑在 contentView.addChildView 的
  // WebContentsView 里），BrowserWindow.webContents 收不到任何渲染代码，send 到它毫无意义。
  // WebContentsView 拥有独立 webContents，必须逐个 send。
  codingAgent = new CodingAgent(config.codingAgent);
  codingAgent.subscribe((status: CodingStatus) => {
    for (const view of allViews()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.send('coding:status', status);
      }
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
