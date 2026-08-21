import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// CJS 模式下 __dirname 是内置的；ESM 模式下需要用 import.meta.url
declare const __dirname: string;

import { loadConfig } from './config';
import type { LoadedConfig } from './config';
import { logger, initLogger, registerLogHandlers, closeLogger } from './logger';
import { initUpdater, checkForUpdates } from './updater';

let mainWindow: BrowserWindow | null = null;
let loadingView: WebContentsView | null = null;
let retryView: WebContentsView | null = null;
let errorView: WebContentsView | null = null;
let contentView: WebContentsView | null = null; // URL 内容也用 View 承载，避免默认 webContents 空白穿透
let retryCount = 0;
let loadFailed = false; // tracking：最近一次 URL 加载是否失败，避免 did-finish-load 覆盖 retry/error 视图

const log = logger.child('main');

/** 同一时刻仅一个 View 可见；传入 null 表示隐藏全部 */
function showOnly(view: WebContentsView | null) {
  loadingView?.setVisible(view === loadingView);
  retryView?.setVisible(view === retryView);
  errorView?.setVisible(view === errorView);
  contentView?.setVisible(view === contentView);
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

function createMainWindow(config: LoadedConfig) {
  const isDev = !app.isPackaged;
  const TARGET_URL = config.targetUrl;
  const MAX_RETRIES = config.maxRetries;
  const RETRY_DELAY_MS = config.retryDelayMs;
  const ALLOWED_ORIGIN_PREFIX = config.allowedOriginPrefix;

  mainWindow = new BrowserWindow({
    width: config.width,
    height: config.height,
    minWidth: config.minWidth,
    minHeight: config.minHeight,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // 关键修复：默认 webContents 不加载 URL，避免 URL 为空白/慢加载时穿透到背景
  // 改用一个 WebContentsView 承载 URL 内容

  // 创建四个 View：loading / retry / error / content(URL)
  loadingView = createView('splash.html');
  retryView = createView('retry.html');
  // errorView 需要展示 targetUrl 给用户（提示哪个服务连不上）
  errorView = createView('error.html', { targetUrl: TARGET_URL });
  contentView = createUrlView(TARGET_URL); // URL 内容用自己的 View

  // 初始显示 loadingView
  showOnly(loadingView);

  // 立即显示窗口（带着 loadingView），让用户看到加载 UI
  mainWindow.show();

  // URL 内容加载成功（用 contentView.webContents 监听，不是默认 webContents）
  // 注意：did-finish-load 也会在 ERR_CONNECTION_REFUSED 触发的 ERR 页面加载完之后被触发，
  // 因此必须配合 loadFailed 标志判断：仅当最近一次加载未失败时才切换到 contentView
  contentView.webContents.on('did-finish-load', () => {
    if (loadFailed) {
      log.debug('content view did-finish-load but load was marked as failed, ignoring');
      return;
    }
    log.info('content view did-finish-load, switching to contentView');
    showOnly(contentView);
  });

  // URL 内容加载失败 → 进入重试或错误页
  contentView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    loadFailed = true;
    log.error(`content view did-fail-load: ${errorCode} ${errorDescription} url=${validatedURL}`);
    if (retryCount < MAX_RETRIES) {
      retryCount += 1;
      log.warn(`retry ${retryCount}/${MAX_RETRIES}`);
      retryView?.webContents.executeJavaScript(
        `document.querySelector('.label').textContent = '正在重试 ${retryCount}/${MAX_RETRIES}…';`
      );
      showOnly(retryView);
      setTimeout(() => {
        // 重试前重置标志，让下次 did-finish-load（如果成功）能切换到 contentView
        loadFailed = false;
        if (contentView && !contentView.webContents.isDestroyed()) {
          contentView.webContents.reload();
        }
      }, RETRY_DELAY_MS);
    } else {
      log.error(`gave up after ${MAX_RETRIES} retries, switching to error view`);
      showOnly(errorView);
    }
  });

  contentView.webContents.on('render-process-gone', (_event, details) => {
    log.error(`render-process-gone: ${JSON.stringify(details)}`);
  });

  contentView.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 拦截非目标 origin 的导航
  contentView.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ALLOWED_ORIGIN_PREFIX)) {
      event.preventDefault();
      log.warn(`will-navigate blocked: ${url}`);
    }
  });

  // 错误页点「重试」→ IPC 回主进程
  ipcMain.on('retry:request', () => {
    log.info('user triggered retry from error view');
    retryCount = 0;
    loadFailed = false;
    showOnly(loadingView);
    if (contentView && !contentView.webContents.isDestroyed()) {
      contentView.webContents.reload();
    }
  });

  // resize 同步所有 View 的 bounds
  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getContentSize();
    for (const v of [loadingView, retryView, errorView, contentView]) {
      v?.setBounds({ x: 0, y: 0, width: w, height: h });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    loadingView = null;
    retryView = null;
    errorView = null;
    contentView = null;
  });

  if (isDev) {
    contentView.webContents.openDevTools({ mode: 'detach' });
  }
}

// loadConfig() 是 async（内部调 app.getPath('userData')），esbuild CJS 拒绝顶层 await，故在 whenReady 内 await
app.whenReady().then(async () => {
  initLogger();
  log.info('app ready');
  registerLogHandlers();
  const config = await loadConfig();
  log.info(`config loaded: ${config.width}x${config.height}`);
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
  closeLogger();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
