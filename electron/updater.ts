import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import { BrowserWindow, ipcMain, app } from 'electron';
import * as path from 'node:path';
import { logger } from './logger';
import type { UpdateChannel } from './config';

const log = logger.child('updater');

export interface UpdateConfig {
  autoUpdate: boolean;
  updateChannel: UpdateChannel;
  /** dismiss 后静默期（小时）。0=立即重提示 */
  dismissCooldownHours: number;
}

// 模块级状态
let updateWindow: BrowserWindow | null = null;
let dismissedVersion: string | null = null;
let lastDismissedAt: number = 0;
let dismissCooldownMs: number = 24 * 60 * 60 * 1000; // 默认 24h，由 config 覆盖

/**
 * 初始化：配置 feed URL + 注册事件 + 注册 IPC。
 * 必须在 app.whenReady() 之后调用（依赖 app.getVersion()）。
 */
export function initUpdater(config: UpdateConfig): void {
  // app:version 始终注册，让 updater dialog 无论 autoUpdate 是否启用都能拿到当前版本
  ipcMain.handle('app:version', () => app.getVersion());

  if (!config.autoUpdate) {
    log.info('autoUpdate disabled by config');
    return;
  }

  // 配置更新源（GitHub Releases）
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'hdcljt',
    repo: 'macapp',
    channel: config.updateChannel === 'beta' ? 'beta' : 'latest',
  });

  // 关闭自动下载 → 用户点确认才下载
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // 配置静默期
  dismissCooldownMs = config.dismissCooldownHours * 60 * 60 * 1000;
  log.info(`updater initialized: channel=${config.updateChannel}, cooldown=${config.dismissCooldownHours}h`);

  // 事件订阅
  autoUpdater.on('checking-for-update', () => {
    log.info('checking for update');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info(`update available: ${info.version} (current: ${app.getVersion()})`);
    showUpdateWindow(info);
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log.info(`up to date: ${info.version}`);
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    const pct = progress.percent;
    // 用户关闭对话框后 updateWindow=null，但仍可能收到后续 progress 事件，
    // 仅 log.debug 不发 IPC（webContents.send 会被可选链静默吞掉）
    if (!updateWindow?.webContents || updateWindow.isDestroyed()) return;
    log.debug(`progress: ${pct.toFixed(1)}%`);
    updateWindow.webContents.send('updater:progress', pct);
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info(`downloaded: ${info.version}`);
    if (!updateWindow?.webContents || updateWindow.isDestroyed()) return;
    updateWindow.webContents.send('updater:downloaded');
  });

  autoUpdater.on('error', (err: Error) => {
    log.error(`updater error: ${err.message}`);
    if (!updateWindow?.webContents || updateWindow.isDestroyed()) return;
    updateWindow.webContents.send('updater:error', err.message);
  });

  // IPC handlers（updater.html 通过 preload 触发）
  ipcMain.handle('updater:download', async () => {
    log.info('user triggered download from dialog');
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      log.error(`download failed: ${(err as Error).message}`);
      throw err; // 让 preload 捕获并显示错误
    }
  });

  ipcMain.handle('updater:install', () => {
    log.info('user triggered install, quitting...');
    // 第二个参数 true = silent 安装（仅 Windows 生效：Squirrel 自动替换 + 重启）
    // macOS 上 silent 参数无效，electron-updater 在 macOS 走手动替换流程
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('updater:dismiss', (_e, version: string) => {
    dismissedVersion = version;
    lastDismissedAt = Date.now();
    log.info(`user dismissed update ${version}`);
    closeUpdateWindow();
  });
}

/**
 * 启动一次检测。启动时调用一次。
 * 若用户在该版本的静默期内 dismiss 过则跳过。
 */
export function checkForUpdates(): void {
  if (dismissedVersion && Date.now() - lastDismissedAt < dismissCooldownMs) {
    log.info(`skipped check, dismissed version ${dismissedVersion} still in cooldown`);
    return;
  }
  autoUpdater
    .checkForUpdates()
    .catch((err) => log.error(`check failed: ${(err as Error).message}`));
}

/** 创建更新对话框 */
function showUpdateWindow(info: UpdateInfo): void {
  // 关闭旧的（防御性，正常流程不会触发）
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.close();
  }

  // releaseNotes 可能是 string 或 { note: string | null }[]（GitHub provider 格式）
  const notes = typeof info.releaseNotes === 'string'
    ? info.releaseNotes
    : Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((n: { note: string | null }) => n.note || '').join('\n\n')
      : '';

  // parent 选择：focused → 任意窗口 → 不绑定。
  // 注：spec §3.1 写的是 `getFocusedWindow() ?? mainWindow`，但 updater.ts 模块
  // 无法访问 mainWindow（不同模块作用域），用 getAllWindows()[0] 兜底等价。
  const focused = BrowserWindow.getFocusedWindow();
  const parent = focused ?? (BrowserWindow.getAllWindows()[0] ?? undefined);

  updateWindow = new BrowserWindow({
    width: 480,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '发现新版本',
    parent,
    modal: process.platform === 'darwin',
    alwaysOnTop: false,
    skipTaskbar: process.platform === 'darwin',
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--update-version=${info.version}`,
        `--update-notes=${encodeURIComponent(notes)}`,
      ],
    },
  });

  updateWindow.setMenuBarVisibility(false);

  // 渲染进程加载完后才显示（避免白屏闪烁）
  updateWindow.once('ready-to-show', () => {
    updateWindow?.show();
  });

  updateWindow.on('closed', () => {
    updateWindow = null;
  });

  updateWindow.loadFile(path.join(__dirname, 'updater.html'));
}

/** 关闭对话框 */
function closeUpdateWindow(): void {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.close();
  }
}
