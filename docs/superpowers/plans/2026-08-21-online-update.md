# Online Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add online update capability via electron-updater + GitHub Releases: start-up detection → independent update dialog → user-initiated download/install → macOS ad-hoc signature accepted with full-DMG fallback.

**Architecture:** A new `electron/updater.ts` module wraps `electron-updater`'s `autoUpdater`. Main process checks at startup; if a new version is found, an independent BrowserWindow shows a modal dialog (HTML + preload IPC) where the user clicks "立即更新" / "以后再说". Behavior is config-driven via 3 new fields in `config.jsonc` (autoUpdate / updateChannel / dismissCooldownHours). All update failures are logged but never block the main window.

**Tech Stack:** electron-updater 6.x, Electron 43 BrowserWindow, TypeScript 7, esbuild (auto-bundles electron-updater), GitHub Releases as update source.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | MODIFY | Add `electron-updater` devDep; add `build.publish` GitHub provider config |
| `electron/config.ts` | MODIFY | Add 3 fields to `AppConfig` + validation in `validateConfig` |
| `electron/preload.ts` | MODIFY | Expose `window.electronAPI.updater.*` (download/install/dismiss/onProgress/onDownloaded/onError) |
| `electron/main.ts` | MODIFY | Call `initUpdater` + `checkForUpdates` inside `app.whenReady()` after `createMainWindow` (try-catch guarded) |
| `electron/updater.ts` | CREATE | Wraps electron-updater: feed URL, event subscriptions, IPC handlers, modal dialog lifecycle, dismiss tracking with cooldown |
| `electron/updater.html` | CREATE | Update dialog UI: version info + release notes + progress bar + buttons |
| `electron/updater.js` | CREATE | Dialog script: reads preload args, subscribes to IPC, button handlers, macOS-specific install guidance |
| `scripts/build-electron.js` | MODIFY | Copy `updater.html` + `updater.js` to `dist-electron/`; add comment about electron-updater bundle strategy |
| `config.jsonc` | MODIFY | Add 3 example fields: `autoUpdate` / `updateChannel` / `dismissCooldownHours` |
| `.github/workflows/build-macos.yml` | MODIFY | Add `latest.yml` + `latest-mac.yml` to artifact upload paths |
| `README.md` | MODIFY | New "🔄 在线更新" section between "📋 日志文件" and "🐛 常见问题" |
| `BUILD.md` | MODIFY | Delete Q6 stub; update "🎯 建议"; add "🔄 自动更新机制" section |

## Task Dependency Graph

```
Task 1 (deps + package.json)       ← standalone
        ↓
Task 2 (config.ts schema)          ← standalone
        ↓
Task 3 (updater.html + .js)        ← standalone (UI shell)
        ↓
Task 4 (preload IPC)               ← depends on Task 3 (defines API contract)
        ↓
Task 5 (updater.ts core)           ← depends on Task 4 (uses preload contract)
        ↓
Task 6 (main.ts integration)       ← depends on Task 5
        ↓
Task 7 (build script + CI)         ← depends on Task 5 (copies new static files)
        ↓
Task 8 (docs)                      ← depends on Task 6 (implementation final)
        ↓
Task 9 (integration verification)  ← depends on all above
```

---

## Task 1: Add electron-updater dependency + publish config

**Files:**
- Modify: `package.json`

**Goal:** Install electron-updater 6.x and declare GitHub Releases as the publish target so electron-builder generates `latest.yml` / `latest-mac.yml` metadata during build.

### Step 1: Install electron-updater

Run from repo root:

```bash
npm install --save-dev electron-updater@^6.7.0
```

Expected: package.json `devDependencies` includes `"electron-updater": "^6.7.x"`.

### Step 2: Add `build.publish` block to package.json

Open `package.json`. Inside the existing `"build"` object (currently ends with `"publish": null` on line 142), replace `null` with the GitHub provider config:

```jsonc
"publish": [
  {
    "provider": "github",
    "owner": "hdcljt",
    "repo": "macapp"
  }
]
```

This makes electron-builder know the target GitHub repo so it generates correct metadata filenames. CI keeps `--publish never` so the builder does not upload to GitHub (the existing `release` job still uploads via `gh release upload`).

### Step 3: Verify package.json is valid JSON

Run:

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).build.publish)"
```

Expected output: `[ { provider: 'github', owner: 'hdcljt', repo: 'macapp' } ]`

### Step 4: Commit

```bash
git add package.json package-lock.json
git commit -F /tmp/commit-update-task1.txt
```

Commit message (write to `/tmp/commit-update-task1.txt` first to satisfy the project's 3-section Chinese format hook):

```
【需求/缺陷描述】: 在线更新 - 安装 electron-updater 依赖
【需求/缺陷单号】: 无
【修改内容】:
- 添加 electron-updater ^6.7.0 到 devDependencies
- package.json build.publish 配置 GitHub provider (hdcljt/macapp)
- 让 electron-builder 生成 latest.yml / latest-mac.yml metadata
- CI 仍走 --publish never + gh release upload 流程
```

---

## Task 2: Extend config.ts schema with 3 new fields

**Files:**
- Modify: `electron/config.ts`
- Modify: `config.jsonc` (repo root)

**Goal:** Add `autoUpdate` / `updateChannel` / `dismissCooldownHours` to `AppConfig`. Validate strictly (hard-fail on missing or wrong type — matches existing 7-field behavior). Update bundled default `config.jsonc`.

### Step 1: Extend `AppConfig` interface

Open `electron/config.ts`. After the existing `minHeight` field (line 27), add:

```ts
  /** 是否启用在线更新检测（默认 true；运维可设 false 关闭） */
  autoUpdate: boolean;
  /** 更新通道：stable（仅正式版）/ beta（含 v*rc*/v*beta*） */
  updateChannel: UpdateChannel;
  /** dismiss 后静默期（小时）。0=立即重提示，>0=静默，默认 24 */
  dismissCooldownHours: number;
```

Then add the type alias above `AppConfig` (after line 6 `const log = ...`):

```ts
export type UpdateChannel = 'stable' | 'beta';
```

### Step 2: Extend `validateConfig`

In the `validateConfig` function (lines 152-234), add validation blocks after the existing `height` check (line 219) and before `if (errors.length > 0)` (line 221):

```ts
  // autoUpdate
  if (!('autoUpdate' in o)) {
    errors.push('字段 autoUpdate 缺失');
  } else if (typeof o.autoUpdate !== 'boolean') {
    errors.push(`autoUpdate 必须是 boolean (实际: ${JSON.stringify(o.autoUpdate)})`);
  }

  // updateChannel
  if (!('updateChannel' in o)) {
    errors.push('字段 updateChannel 缺失');
  } else if (o.updateChannel !== 'stable' && o.updateChannel !== 'beta') {
    errors.push(`updateChannel 必须是 'stable' 或 'beta' (实际: ${JSON.stringify(o.updateChannel)})`);
  }

  // dismissCooldownHours
  if (!('dismissCooldownHours' in o)) {
    errors.push('字段 dismissCooldownHours 缺失');
  } else if (!Number.isInteger(o.dismissCooldownHours) || (o.dismissCooldownHours as number) < 0) {
    errors.push(`dismissCooldownHours 必须是非负整数 (实际: ${JSON.stringify(o.dismissCooldownHours)})`);
  }
```

### Step 3: Update the return value

In the `return` block (lines 225-233), add the 3 new fields:

```ts
  return {
    targetUrl: o.targetUrl as string,
    maxRetries: o.maxRetries as number,
    retryDelayMs: o.retryDelayMs as number,
    width: o.width as number,
    height: o.height as number,
    minWidth: o.minWidth as number,
    minHeight: o.minHeight as number,
    autoUpdate: o.autoUpdate as boolean,
    updateChannel: o.updateChannel as UpdateChannel,
    dismissCooldownHours: o.dismissCooldownHours as number,
  };
```

### Step 4: Update bundled default config.jsonc

Open `config.jsonc` (repo root). Add at the end (after `"minHeight": 700`):

```jsonc
  // 是否启用在线更新检测（启动后自动检查 GitHub Releases）。默认 true
  "autoUpdate": true,

  // 更新通道：stable（仅正式版）/ beta（含预发布 v*rc* / v*beta*）
  "updateChannel": "stable",

  // dismiss 后静默期（小时）。误点「以后再说」想立即再看 → 改 0 后重启。默认 24
  "dismissCooldownHours": 24
```

### Step 5: Verify TypeScript compiles

Run:

```bash
npx tsc --noEmit
```

Expected: no errors.

### Step 6: Manual smoke test — missing field should hard-fail

Run:

```bash
npm run build:electron
```

Expected: TypeScript compile succeeds. Then temporarily delete `"autoUpdate": true,` from `config.jsonc` (we'll restore in next step) and run:

```bash
node dist-electron/main.js
```

Expected: process exits 1 with stderr containing `[config] ✗ 字段校验失败` and `- 字段 autoUpdate 缺失`.

Restore the deleted field.

### Step 7: Commit

```bash
git add electron/config.ts config.jsonc
git commit -F /tmp/commit-update-task2.txt
```

Commit message:

```
【需求/缺陷描述】: 在线更新 - config schema 增加 3 个字段
【需求/缺陷单号】: 无
【修改内容】:
- AppConfig 新增 autoUpdate（boolean）/ updateChannel（stable|beta）/ dismissCooldownHours（>=0 整数）
- validateConfig 新增 3 个字段的硬失败校验（缺失或类型错误→ 启动失败）
- config.jsonc 默认值示例增加 3 个字段，默认 autoUpdate=true / updateChannel=stable / dismissCooldownHours=24
- 与现有 7 字段「所有校验错误都是硬失败」原则一致
```

---

## Task 3: Create updater.html + updater.js UI shell

**Files:**
- Create: `electron/updater.html`
- Create: `electron/updater.js`

**Goal:** Build the dialog UI as standalone HTML + plain JS (matches the existing `splash.html` / `error.html` pattern). The dialog shows version info, release notes, a progress bar, and 3 buttons (later/update/install).

### Step 1: Create `electron/updater.html`

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self';" />
  <title>发现新版本</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      padding: 24px;
      margin: 0;
      color: #1d1d1f;
      background: #ffffff;
      user-select: none;
    }
    .version {
      font-size: 13px;
      color: #86868b;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 18px;
      font-weight: 600;
      margin: 0 0 12px;
    }
    .notes {
      font-size: 13px;
      color: #424245;
      max-height: 120px;
      overflow-y: auto;
      background: #f5f5f7;
      padding: 10px 12px;
      border-radius: 6px;
      white-space: pre-wrap;
      line-height: 1.5;
    }
    .progress-wrap {
      margin-top: 16px;
      display: none;
    }
    .progress-bar {
      width: 100%;
      height: 4px;
      background: #e5e5ea;
      border-radius: 2px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: #0071e3;
      width: 0%;
      transition: width 0.3s;
    }
    .progress-label {
      font-size: 11px;
      color: #86868b;
      margin-top: 4px;
      text-align: right;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 20px;
    }
    button {
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid #d2d2d7;
      background: #fff;
      cursor: pointer;
      font-size: 13px;
      color: #1d1d1f;
      font-family: inherit;
    }
    button.primary {
      background: #0071e3;
      color: #fff;
      border-color: #0071e3;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button:focus {
      outline: 2px solid #0071e3;
      outline-offset: 1px;
    }
    .error-msg {
      margin-top: 12px;
      padding: 8px 12px;
      background: #fff2f2;
      border-radius: 6px;
      color: #d70015;
      font-size: 12px;
      display: none;
    }
  </style>
</head>
<body>
  <div class="version">v<span id="current"></span> → v<span id="latest"></span></div>
  <h1>发现新版本</h1>
  <div class="notes" id="notes"></div>
  <div class="progress-wrap" id="progress-wrap">
    <div class="progress-bar"><div class="progress-fill" id="fill"></div></div>
    <div class="progress-label" id="progress-label">下载中… 0%</div>
  </div>
  <div class="error-msg" id="error-msg"></div>
  <div class="actions">
    <button id="btn-later">以后再说</button>
    <button id="btn-install" class="primary" style="display:none">立即安装</button>
    <button id="btn-update" class="primary">立即更新</button>
  </div>
  <script src="updater.js"></script>
</body>
</html>
```

### Step 2: Create `electron/updater.js`

```js
// 解析 preload 通过 additionalArguments 传入的版本信息
const args = process.argv.filter(a => a.startsWith('--update-'));
const getArg = (key) => {
  const arg = args.find(a => a.startsWith(`--update-${key}=`));
  if (!arg) return '';
  return decodeURIComponent(arg.split('=').slice(1).join('='));
};

const isMac = window.electronAPI.platform === 'darwin';

// 填充版本号（当前版本从 preload 注入的 versions.app 读取）
document.getElementById('current').textContent = window.electronAPI.versions.app || '?';
document.getElementById('latest').textContent  = getArg('version') || '?';

// 显示 release notes（原始字符串；无格式化渲染）
const notesText = getArg('notes');
document.getElementById('notes').textContent = notesText || '本次更新包含若干改进与问题修复。';

// DOM 引用
const btnUpdate   = document.getElementById('btn-update');
const btnInstall  = document.getElementById('btn-install');
const btnLater    = document.getElementById('btn-later');
const progressWrap = document.getElementById('progress-wrap');
const progressLabel = document.getElementById('progress-label');
const fill = document.getElementById('fill');
const errorMsg = document.getElementById('error-msg');
const version = getArg('version');

// 进度事件
window.electronAPI.updater.onProgress((pct) => {
  progressWrap.style.display = 'block';
  const rounded = Math.round(pct);
  fill.style.width = rounded + '%';
  progressLabel.textContent = `下载中… ${rounded}%`;
});

// 下载完成 → 显示「立即安装」按钮
window.electronAPI.updater.onDownloaded(() => {
  progressWrap.style.display = 'none';
  btnUpdate.style.display   = 'none';
  btnInstall.style.display  = 'inline-block';
  btnLater.disabled         = false;
});

// 错误事件
window.electronAPI.updater.onError((msg) => {
  errorMsg.style.display = 'block';
  if (isMac) {
    errorMsg.textContent = `下载失败：${msg}\n请前往 GitHub Releases 手动下载最新版本。`;
  } else {
    errorMsg.textContent = `下载失败：${msg}\n请前往 GitHub Releases 手动下载最新版本。`;
  }
  btnUpdate.disabled = false;
  btnLater.disabled  = false;
});

// 点击「立即更新」
btnUpdate.addEventListener('click', async () => {
  btnUpdate.disabled = true;
  btnLater.disabled  = true;
  try {
    await window.electronAPI.updater.download();
  } catch (err) {
    errorMsg.style.display = 'block';
    errorMsg.textContent = '启动下载失败：' + (err.message || err);
    btnUpdate.disabled = false;
    btnLater.disabled  = false;
  }
});

// 点击「立即安装」
btnInstall.addEventListener('click', () => {
  if (isMac) {
    alert(
      '更新包已下载到「下载」文件夹（macOS 上 electron-updater 会放到 cache 目录）。\n' +
      '请退出当前应用后：\n' +
      '1. 打开 Finder → 找到新版本的 .dmg 或 .zip\n' +
      '2. 双击挂载，将「算粒AI助手」拖入「应用程序」文件夹\n' +
      '3. 在「应用程序」中启动新版本'
    );
  }
  window.electronAPI.updater.install();
});

// 点击「以后再说」
btnLater.addEventListener('click', () => {
  window.electronAPI.updater.dismiss(version);
});
```

### Step 3: Verify the files exist

Run:

```bash
ls -la electron/updater.html electron/updater.js
```

Expected: both files exist.

### Step 4: Commit

```bash
git add electron/updater.html electron/updater.js
git commit -F /tmp/commit-update-task3.txt
```

Commit message:

```
【需求/缺陷描述】: 在线更新 - 对话框 UI 静态资源
【需求/缺陷单号】: 无
【修改内容】:
- 新增 electron/updater.html：版本号、release notes、进度条、3 按钮（立即更新/立即安装/以后再说）
- 新增 electron/updater.js：解析 preload 传入的 version/notes/argv，订阅 IPC，绑定按钮事件
- macOS 平台在「立即安装」时弹引导 dialog 提示手动替换（ad-hoc 签名场景）
- 风格与现有 splash.html / error.html 一致（SF Pro + 白底 + 居中）
```

---

## Task 4: Extend preload.ts with updater IPC contract

**Files:**
- Modify: `electron/preload.ts`

**Goal:** Expose `window.electronAPI.updater.*` so the dialog can invoke main-process handlers and subscribe to progress / downloaded / error events.

### Step 1: Replace the existing contextBridge block

Replace the entire `contextBridge.exposeInMainWorld('electronAPI', { ... })` block (lines 4-15) with:

```ts
import { contextBridge, ipcRenderer } from 'electron';

// 暴露给 splash / retry / error / updater 页面的 API
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    app: process.env.npm_package_version || 'unknown',
  },
  retry: () => ipcRenderer.send('retry:request'),
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.invoke('log:write', level, message);
  },
  updater: {
    /** 触发下载（用户点击「立即更新」后调用） */
    download: (): Promise<void> => ipcRenderer.invoke('updater:download'),
    /** 触发安装 + 退出应用（用户点击「立即安装」后调用） */
    install: (): Promise<void> => ipcRenderer.invoke('updater:install'),
    /** 用户点击「以后再说」（version 用于 dismiss 追踪） */
    dismiss: (version: string): Promise<void> => ipcRenderer.invoke('updater:dismiss', version),
    /** 订阅下载进度事件 */
    onProgress: (cb: (percent: number) => void): void => {
      ipcRenderer.on('updater:progress', (_e, pct: number) => cb(pct));
    },
    /** 订阅下载完成事件 */
    onDownloaded: (cb: () => void): void => {
      ipcRenderer.on('updater:downloaded', () => cb());
    },
    /** 订阅错误事件 */
    onError: (cb: (msg: string) => void): void => {
      ipcRenderer.on('updater:error', (_e, msg: string) => cb(msg));
    },
  },
});
```

Note: `versions.app` exposes the current app version (read from `process.env.npm_package_version` at runtime; esbuild bundles this as a literal at build time so the dialog can show "current" version).

### Step 2: Verify TypeScript compiles

Run:

```bash
npx tsc --noEmit
```

Expected: no errors.

### Step 3: Commit

```bash
git add electron/preload.ts
git commit -F /tmp/commit-update-task4.txt
```

Commit message:

```
【需求/缺陷描述】: 在线更新 - preload 暴露 updater IPC
【需求/缺陷单号】: 无
【修改内容】:
- preload.ts contextBridge 增加 electronAPI.updater.* 命名空间
- 暴露 download / install / dismiss 三个 invoke 方法
- 暴露 onProgress / onDownloaded / onError 三个事件订阅方法
- versions 增加 app 字段（当前应用版本号）供 updater.html 显示
- 保持与现有 log / retry 同构的 contextBridge 风格
```

---

## Task 5: Create electron/updater.ts core module

**Files:**
- Create: `electron/updater.ts`

**Goal:** Implement the full updater wrapper: feed URL configuration, event subscriptions, IPC handlers, modal dialog lifecycle, dismiss tracking with configurable cooldown. No integration into main.ts yet — just the module.

### Step 1: Create `electron/updater.ts` with full implementation

```ts
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
let updateInfo: UpdateInfo | null = null;
let dismissedVersion: string | null = null;
let lastDismissedAt: number = 0;
let dismissCooldownMs: number = 24 * 60 * 60 * 1000; // 默认 24h，由 config 覆盖

/**
 * 初始化：配置 feed URL + 注册事件 + 注册 IPC。
 * 必须在 app.whenReady() 之后调用（依赖 app.getVersion()）。
 */
export function initUpdater(config: UpdateConfig): void {
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
    updateInfo = info;
    showUpdateWindow(info);
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log.info(`up to date: ${info.version}`);
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    const pct = progress.percent;
    log.debug(`progress: ${pct.toFixed(1)}%`);
    updateWindow?.webContents.send('updater:progress', pct);
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info(`downloaded: ${info.version}`);
    updateWindow?.webContents.send('updater:downloaded');
  });

  autoUpdater.on('error', (err: Error) => {
    log.error(`updater error: ${err.message}`);
    updateWindow?.webContents.send('updater:error', err.message);
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
    // 第二个参数 true = silent 安装（Windows 自动）
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

  // releaseNotes 可能是 string 或 { note: string }[]（GitHub provider 格式）
  const notes = typeof info.releaseNotes === 'string'
    ? info.releaseNotes
    : Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((n: any) => n.note || '').join('\n\n')
      : '';

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
```

### Step 2: Verify TypeScript compiles

Run:

```bash
npx tsc --noEmit
```

Expected: no errors (electron-updater types may need `@types`; if missing, the install in Task 1 should have brought them transitively).

### Step 3: Commit

```bash
git add electron/updater.ts
git commit -F /tmp/commit-update-task5.txt
```

Commit message:

```
【需求/缺陷描述】: 在线更新 - 核心模块 updater.ts
【需求/缺陷单号】: 无
【修改内容】:
- 新增 electron/updater.ts（~190 行）：electron-updater 封装
- 公开 API：initUpdater(config) / checkForUpdates()
- 内部状态：updateWindow / updateInfo / dismissedVersion / lastDismissedAt / dismissCooldownMs
- setFeedURL 配置 GitHub Releases + channel（stable/beta）
- 订阅 6 个 autoUpdater 事件 + 3 个 IPC handler
- showUpdateWindow 创建独立 BrowserWindow（modal macOS / non-modal Windows）
- dismissCooldownHours 静默期控制（默认 24h，0=立即重提示）
- 不阻断主流程：事件全部仅 log + IPC 推送，不 throw
```

---

## Task 6: Integrate updater into main.ts

**Files:**
- Modify: `electron/main.ts`

**Goal:** Wire `initUpdater` + `checkForUpdates` into the existing `app.whenReady()` flow. The call must happen **after** `createMainWindow` and be wrapped in try-catch so any updater failure cannot block the already-running main window.

### Step 1: Add updater import

At the top of `electron/main.ts` (after the existing `import { logger, initLogger, registerLogHandlers, closeLogger } from './logger';` on line 9), add:

```ts
import { initUpdater, checkForUpdates } from './updater';
```

### Step 2: Wire updater init into whenReady

Find the `app.whenReady().then(async () => { ... })` block (lines 195-209). Inside it, **after** `createMainWindow(config);` (line 201), add:

```ts
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
```

Final structure of the whenReady body (after this change) should look like:

```ts
app.whenReady().then(async () => {
  initLogger();
  log.info('app ready');
  registerLogHandlers();
  const config = await loadConfig();
  log.info(`config loaded: ${config.width}x${config.height}`);
  createMainWindow(config);
  log.info(`createMainWindow end: ${config.width}x${config.height}`);

  // 主窗口已显示后再启动 updater
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
```

### Step 3: Verify TypeScript compiles

Run:

```bash
npx tsc --noEmit
```

Expected: no errors.

### Step 4: Build

Run:

```bash
npm run build:electron
```

Expected: build succeeds. esbuild will inline `electron-updater` into `dist-electron/main.js` (~+200KB). Check the output size:

```bash
ls -lh dist-electron/main.js
```

Expected: file size is around 250-300 KB (was ~50KB without electron-updater).

### Step 5: Manual smoke test — dev mode startup

Run:

```bash
npm run dev:electron
```

Expected:

1. App launches normally (splash → content)
2. Tail the log file:
   ```bash
   tail -f ~/Library/Application\ Support/算粒AI助手/logs/main.log    # macOS
   type %APPDATA%\算粒AI助手\logs\main.log                          # Windows
   ```
3. Within a few seconds of startup, log shows:
   ```
   [INFO] [updater] updater initialized: channel=stable, cooldown=24h
   [INFO] [updater] checking for update
   [INFO] [updater] up to date: 0.4.0
   ```
   (or `update available: 0.5.0` if there's a newer GitHub release)

If `update available` appears, a dialog should pop up. Click "以后再说" → log shows `user dismissed update 0.5.0`.

### Step 6: Verify shutdown still writes footer

In the dev process, quit the app (Cmd+Q / Alt+F4). Check log file end has:

```
=== log ended at <ISO> ===
```

### Step 7: Commit

```bash
git add electron/main.ts
git commit -F /tmp/commit-update-task6.txt
```

Commit message:

```
【需求/缺陷描述】: 在线更新 - main.ts 集成 updater
【需求/缺陷单号】: 无
【修改内容】:
- main.ts 引入 initUpdater / checkForUpdates
- app.whenReady 内 createMainWindow 之后启动 updater
- 包在 setImmediate + try-catch：任何 updater 异常都不影响主窗口
- 显式传递 config 的 3 个新字段（autoUpdate / updateChannel / dismissCooldownHours）
- 与 logger 模块同构：主流程完成后异步追加、可选、可降级
```

---

## Task 7: Update build script to copy updater static files + CI upload paths

**Files:**
- Modify: `scripts/build-electron.js`
- Modify: `.github/workflows/build-macos.yml`

**Goal:** Ensure `updater.html` + `updater.js` get copied to `dist-electron/` (so main.js's `__dirname/updater.html` resolves at runtime), and CI uploads `latest.yml` + `latest-mac.yml` to GitHub Releases.

### Step 1: Add updater static files to build-electron.js

Open `scripts/build-electron.js`. Find the `staticFiles` array (line 51):

```js
  const staticFiles = ['splash.html', 'retry.html', 'error.html', 'error.js'];
```

Replace with:

```js
  // electron-updater 会被 esbuild inline bundle 进 main.js（无需额外配置）
  // 但 updater.html / upddater.js 是运行时静态资源，必须手动复制到 dist-electron
  const staticFiles = ['splash.html', 'retry.html', 'error.html', 'error.js', 'updater.html', 'updater.js'];
```

Also add a comment block above the `external: ['electron']` line (around line 31) documenting the bundle strategy:

```js
    // electron-updater 由 esbuild inline bundle（依赖 electron 自身 API，
    // 不能 external 化）。预期 main.js 体积 +200KB。
```

### Step 2: Run build and check dist-electron

```bash
npm run build:electron
ls -la dist-electron/
```

Expected: `dist-electron/` contains `main.js`, `preload.js`, `splash.html`, `retry.html`, `error.html`, `error.js`, `updater.html`, `updater.js`.

### Step 3: Update GitHub Actions workflow

Open `.github/workflows/build-macos.yml`. There are 3 artifact upload blocks (macOS x64, macOS arm64, macOS universal, Windows). For each `actions/upload-artifact@v4` step, add `latest.yml` and `latest-mac.yml` to the `path:` list.

For example, find the macOS x64 job's upload step (around lines 63-71) which currently has:

```yaml
          path: |
            release/**/*.dmg
            release/**/*.zip
            release/**/*.blockmap
```

Replace with:

```yaml
          path: |
            release/**/*.dmg
            release/**/*.zip
            release/**/*.blockmap
            release/**/latest.yml
            release/**/latest-mac.yml
```

Repeat this change for the macOS universal job (around lines 105-112) and the Windows job (around lines 157-163).

### Step 4: Commit

```bash
git add scripts/build-electron.js .github/workflows/build-macos.yml
git commit -F /tmp/commit-update-task7.txt
```

Commit message:

```
【需求/缺陷描述】: 在线更新 - build 脚本与 CI 上传清单
【需求/缺陷单号】: 无
【修改内容】:
- scripts/build-electron.js：staticFiles 新增 updater.html + updater.js
- 添加注释说明 electron-updater inline bundle 策略（依赖 electron API 不能 external）
- .github/workflows/build-macos.yml：3 个 artifact upload 块都增加 latest.yml + latest-mac.yml
- CI 仍走 --publish never，metadata 文件由现有 gh release upload job 统一发布到 GitHub Releases
```

---

## Task 8: Update documentation (README + BUILD.md)

**Files:**
- Modify: `README.md`
- Modify: `BUILD.md`

**Goal:** Document the new online update feature for end users (README) and operators (BUILD.md).

### Step 1: Add "🔄 在线更新" section to README.md

Open `README.md`. Find the "📋 日志文件" section header (around line 249). Insert a new section **after** "📋 日志文件" and **before** "🐛 常见问题" (around line 299). Use this content:

````markdown
## 🔄 在线更新

应用启动时会自动检查 GitHub Releases 上的最新版本，发现新版后弹窗让用户确认是否更新。

### 工作流程

1. 应用启动 5 秒内异步检查 GitHub Releases
2. 发现新版 → 弹窗显示版本号 + Release Notes
3. 用户选择「立即更新」→ 下载新版本
4. **Windows**：下载完成后自动安装并重启
5. **macOS**（ad-hoc 签名场景）：下载 DMG 后需用户手动拖入「应用程序」文件夹

### 配置更新行为

在 `config.jsonc` 中可控制：

```jsonc
{
  // 是否启用自动检查更新（默认 true）
  "autoUpdate": true,
  // 更新通道：stable（正式版）/ beta（含预发布）
  "updateChannel": "stable",
  // dismiss 后静默期（小时）。误点「以后再说」想立即再看 → 改 0 后重启
  "dismissCooldownHours": 24
}
```

### 用户选择

- **「立即更新」**：开始下载 + 进度条 + 下载完成后弹「立即安装」
- **「以后再说」**：关闭对话框，24 小时内不再提示同一版本

### macOS 签名说明

当前 ad-hoc 签名不支持 Squirrel 增量更新（需要 Apple Developer ID 签名 + 公证）。

**实际行为**：macOS 检测到新版后下载完整 DMG，弹窗引导用户手动替换。

未来配置正式 Apple Developer ID 后，无需修改代码即可启用 macOS 增量更新。

### 调试

dev 模式下查看更新相关日志：

```bash
# macOS
tail -f ~/Library/Application\ Support/算粒AI助手/logs/main.log | grep updater

# Windows
type %APPDATA%\算粒AI助手\logs\main.log | findstr updater
```

### 关闭自动更新

运维场景下需要禁用，修改部署环境的 `config.jsonc`：

```jsonc
{ "autoUpdate": false }
```
````

### Step 2: Update BUILD.md

Open `BUILD.md`. Make 3 changes:

**Change A: Delete Q6** (around line 229-231). Find and remove:

```markdown
### Q6: 想要自动更新

主流方案：[electron-updater](https://www.electron.build/auto-update)

需要配置 `publish` 字段 + 代码签名。
```

**Change B: Update "🎯 建议" section** (around line 257-266). Find:

```markdown
**正式发布**：

- ✅ 配置 Apple 开发者签名

- ✅ Windows EV 代码签名

- ✅ 配置自动更新（electron-updater）

- ✅ 接入 CI/CD 完整流程
```

Replace the bullet "配置自动更新（electron-updater）" with "已接入自动更新（electron-updater + GitHub Releases）".

**Change C: Add new "🔄 自动更新机制" section** — insert **before** the "🎯 建议" section (around line 256). Use:

````markdown
## 🔄 自动更新机制

应用通过 [electron-updater](https://www.electron.build/auto-update) 从 GitHub Releases 拉取更新。

### 工作原理

1. **客户端**：启动后调 `autoUpdater.checkForUpdates()` → 调 GitHub API 拉 `latest` release 元数据
2. **元数据**：builder 在构建时生成 `latest.yml`（Windows）+ `latest-mac.yml`（macOS），含 sha512 + 文件路径
3. **下载**：用户确认后下载新版本安装包（含 Squirrel 差分）
4. **安装**：Windows 自动 Squirrel 替换 + 重启；macOS 引导用户手动操作

### 平台差异

| 平台 | 增量更新 | 安装方式 |
|------|----------|----------|
| Windows (NSIS) | ✅ Squirrel 差分（~10MB 增量） | 自动安装 + 重启 |
| macOS (ad-hoc 签名) | ❌ 不支持（需 Apple Developer ID） | 用户手动拖入 Applications |
| macOS (正式签名) | ✅ Squirrel 差分 | 用户拖入 Applications（macOS 限制） |

### CI 集成

现有 `.github/workflows/build-macos.yml` 已自动把 metadata 上传到 GitHub Release，无需额外配置。

只需确保：

- tag 格式为 `v*`（如 `v0.5.0`）
- `package.json.build.publish` 已配置 `github` provider
- `--publish never` 在 CI 中保留（让 `release` job 统一上传）
````

### Step 3: Verify both files render as expected

Run:

```bash
grep -n "在线更新\|自动更新机制" README.md BUILD.md
```

Expected:

```
README.md:<line>:## 🔄 在线更新
BUILD.md:<line>:## 🔄 自动更新机制
```

### Step 4: Commit

```bash
git add README.md BUILD.md
git commit -F /tmp/commit-update-task8.txt
```

Commit message:

```
【需求/缺陷描述】: 在线更新 - 文档更新
【需求/缺陷单号】: 无
【修改内容】:
- README.md 新增「🔄 在线更新」章节（在日志文件之后、常见问题之前）
- 覆盖工作流程、配置（autoUpdate/updateChannel/dismissCooldownHours）、用户选择、macOS 签名说明、调试、关闭方法
- BUILD.md 删除 Q6 stub（在「🎯 建议」章节已实现）
- BUILD.md 「🎯 建议」中自动更新 bullet 改为「已接入」
- BUILD.md 新增「🔄 自动更新机制」章节：原理 + 平台差异 + CI 集成
```

---

## Task 9: Final integration verification

**Files:** None (verification only)

**Goal:** Confirm end-to-end behavior: dev mode startup logs the updater messages; build produces correct metadata; CI uploads work; no regression to existing features.

### Step 1: Build everything

Run from repo root:

```bash
npm run build:electron
ls -lh dist-electron/
```

Expected:

- `main.js` is 250-300 KB (includes inlined electron-updater)
- `preload.js` includes `electronAPI.updater.*` (grep to verify)
- `updater.html` + `updater.js` exist

```bash
grep -c "updater:" dist-electron/preload.js
```

Expected: ≥ 3 (matches `updater:download`, `updater:install`, `updater:dismiss`).

### Step 2: dev mode startup

Run:

```bash
npm run dev:electron
```

Watch the log file. Within 10 seconds expected lines:

```
[INFO] [main] app ready
[INFO] [config] ✓ 已加载 /path/to/config.jsonc
[INFO] [main] createMainWindow end: 1180x820
[INFO] [updater] updater initialized: channel=stable, cooldown=24h
[INFO] [updater] checking for update
[INFO] [updater] up to date: 0.4.0
```

(Or `update available: 0.5.0` if a newer release exists. In that case a dialog appears — click "以后再说" → log shows `user dismissed update 0.5.0`.)

### Step 3: config-driven behavior

Temporarily edit `config.jsonc`:

```jsonc
{
  ...
  "autoUpdate": false,
  ...
}
```

Restart dev mode. Expected log:

```
[INFO] [updater] autoUpdate disabled by config
```

No `checking for update` line. Restore `autoUpdate: true`.

### Step 4: Windows build (optional, requires Windows or CI)

If on Windows:

```bash
npm run build:win
ls release/0.4.0/
```

Expected: contains `latest.yml`, `*.blockmap`, `*-Setup.exe`.

If on macOS or Linux: skip this step (CI will verify).

### Step 5: macOS build (optional, requires macOS or CI)

If on macOS:

```bash
npm run build:mac
ls release/0.4.0/
```

Expected: contains `latest-mac.yml`, `*.dmg`, `*.zip`.

### Step 6: No regression — existing 7-field config still hard-fails

Temporarily remove `"maxRetries": 3,` from `config.jsonc`. Run:

```bash
node dist-electron/main.js
```

Expected: process exits 1 with `[config] ✗ 字段校验失败` and `- 字段 maxRetries 缺失`. Restore.

### Step 7: No regression — logger still works

Verify the log file (used by both config and updater) still rotates at 5MB and writes header/footer. If you've been running dev mode throughout, the file should have started with:

```
=== log started at <ISO> (...)
```

and after quitting, ended with:

```
=== log ended at <ISO> ===
```

### Step 8: No regression — splash / retry / error views still load

In dev mode, verify:

1. Splash appears immediately on launch
2. If `targetUrl` (in your `config.jsonc`) is unreachable, retry view appears with retry counter
3. After max retries, error view appears

(These flows don't go through updater, so they should be unaffected.)

### Step 9: Final summary commit (no code changes)

If everything passes, no commit is needed — all changes were already committed in Tasks 1-8. Verify final git log:

```bash
git log --oneline -10
```

Expected: 8 new commits at HEAD (Tasks 1-8), each following the project's 3-section Chinese commit format. No extra commits.

---

## Self-Review Checklist (run before declaring plan complete)

- [ ] All 6 spec sections covered: architecture (§1) → Task 5/6; platform differences (§2.3) → Task 5 + Task 8; UI/IPC (§3) → Tasks 3/4/5; config (§3.6) → Task 2; errors/verification (§4) → Task 9; CI (§5) → Task 7
- [ ] All file changes from spec §1.1 accounted for: package.json ✓ Task 1; config.ts ✓ Task 2; preload.ts ✓ Task 4; updater.ts/html/js ✓ Tasks 3/5; main.ts ✓ Task 6; build-electron.js ✓ Task 7; config.jsonc ✓ Task 2; CI workflow ✓ Task 7; README/BUILD ✓ Task 8
- [ ] No placeholders: every step has either complete code or an exact command with expected output
- [ ] Type consistency: `UpdateConfig` interface defined in Task 2, used in Task 5/6; `electronAPI.updater.*` defined in Task 4, used in Task 3 (updater.js) and Task 5 (IPC handlers)
- [ ] Dismiss tracking: `dismissedVersion` + `lastDismissedAt` + `dismissCooldownMs` consistent across Tasks 5/6
- [ ] macOS vs Windows behavior consistent with spec §2.3