import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron';
import path from 'node:path';

// CJS 模式下 __dirname 是内置的；ESM 模式下需要用 import.meta.url
declare const __dirname: string;

const isDev = !app.isPackaged;
const TARGET_URL = 'http://localhost:5195/agent-user/assistant';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

let mainWindow: BrowserWindow | null = null;
let loadingView: WebContentsView | null = null;
let retryView: WebContentsView | null = null;
let errorView: WebContentsView | null = null;
let retryCount = 0;

/** 同一时刻仅一个 View 可见；传入 null 表示隐藏全部（显示默认 webContents） */
function showOnly(view: WebContentsView | null) {
  loadingView?.setVisible(view === loadingView);
  retryView?.setVisible(view === retryView);
  errorView?.setVisible(view === errorView);
}

/** 创建一个覆盖整个 mainWindow 的 WebContentsView，加载本地 HTML */
function createView(htmlFile: string): WebContentsView {
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
  view.webContents.loadFile(path.join(__dirname, htmlFile));
  mainWindow!.contentView.addChildView(view);
  view.setVisible(false);
  return view;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 700,
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
  mainWindow.loadURL(TARGET_URL);

  // 创建三个状态视图，仅 loadingView 可见
  loadingView = createView('splash.html');
  retryView = createView('retry.html');
  errorView = createView('error.html');
  showOnly(loadingView);

  // 默认 webContents 加载成功 → 隐藏所有视图，显示主窗口
  mainWindow.webContents.on('did-finish-load', () => {
    showOnly(null);
    mainWindow?.show();
  });

  // 加载失败 → 进入重试或错误页
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[loadURL] ${errorCode} ${errorDescription} url=${validatedURL}`);
    if (retryCount < MAX_RETRIES) {
      retryCount += 1;
      console.warn(`[retry ${retryCount}/${MAX_RETRIES}]`);
      retryView?.webContents.executeJavaScript(
        `document.querySelector('.label').textContent = '正在重试 ${retryCount}/${MAX_RETRIES}…';`
      );
      showOnly(retryView);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }, RETRY_DELAY_MS);
    } else {
      console.error(`[loadURL] gave up after ${MAX_RETRIES} retries, switching to error view`);
      showOnly(errorView);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[render-process-gone]', details);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 拦截非目标 origin 的导航
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost:5195/')) {
      event.preventDefault();
      console.warn(`[will-navigate blocked] ${url}`);
    }
  });

  // 错误页点「重试」→ IPC 回主进程
  ipcMain.on('retry:request', () => {
    console.log('[retry:request] user triggered retry from error view');
    retryCount = 0;
    showOnly(loadingView);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });

  // resize 同步所有 View 的 bounds
  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getContentSize();
    for (const v of [loadingView, retryView, errorView]) {
      v?.setBounds({ x: 0, y: 0, width: w, height: h });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    loadingView = null;
    retryView = null;
    errorView = null;
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
