import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';

// CJS 模式下 __dirname 是内置的；ESM 模式下需要用 import.meta.url
declare const __dirname: string;

const isDev = !app.isPackaged;
const TARGET_URL = 'http://localhost:5195/agent-user/assistant';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

let splashWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let retryCount = 0;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 600,
    height: 300,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: false,
    show: false,
    backgroundColor: '#F0E8FF',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  splashWindow.setMenuBarVisibility(false);
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  // ready-to-show 在某些 Electron 版本下不会触发；用 did-finish-load 兜底
  const showSplash = () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.show();
    }
  };
  splashWindow.once('ready-to-show', showSplash);
  splashWindow.webContents.once('did-finish-load', showSplash);
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
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

  mainWindow.webContents.on('did-finish-load', () => {
    retryCount = 0;
    mainWindow?.show();
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[loadURL] ${errorCode} ${errorDescription} url=${validatedURL}`);
    if (retryCount < MAX_RETRIES) {
      retryCount += 1;
      console.warn(`[retry ${retryCount}/${MAX_RETRIES}]`);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }, RETRY_DELAY_MS);
    } else {
      console.error(`[loadURL] gave up after ${MAX_RETRIES} retries, switching to error page`);
      showErrorPage();
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function showErrorPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 关闭 splash：它已经展示过了，不再需要
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  const errorPath = path.join(__dirname, 'error.html');
  console.log(`[showErrorPage] loading ${errorPath}`);
  // 无条件先显示 mainWindow，避免 ready-to-show 已触发过导致 once 不再触发
  mainWindow.show();
  mainWindow.webContents.once('did-finish-load', () => {
    console.log('[showErrorPage] error.html loaded');
  });
  mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
    console.error(`[showErrorPage] load failed: ${code} ${desc}`);
  });
  mainWindow.loadFile(errorPath);
}

app.whenReady().then(() => {
  createSplashWindow();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplashWindow();
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
