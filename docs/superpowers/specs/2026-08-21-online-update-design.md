# 在线更新 — 设计文档

日期：2026-08-21
主题：通过 electron-updater + GitHub Releases 实现「启动时检测 → 弹窗确认 → 下载/安装」的用户可控在线更新流程。

## 背景

算粒AI助手当前**没有自动更新机制**，用户必须：

1. 关注 GitHub Releases 页面
2. 手动下载新版 DMG / NSIS
3. 退出旧版 → 安装新版（macOS 拖拽 / Windows NSIS 向导）

核心问题：

- 用户体验差：99% 用户不会主动检查更新，长期停留在旧版
- 安全风险：紧急修复无法快速触达用户
- 运维成本：每次发版后需要逐用户通知

虽然 BUILD.md Q6 已经提到 `electron-updater` 是主流方案，但工程实现细节（与现有 4-View 架构 + 配置系统 + CI 流程的集成）需要明确设计。

## 目标

1. **用户可控**：检测到新版本后弹窗让用户决定，不强制
2. **零额外运维**：复用现有 GitHub Releases 作为更新源，不引入新服务器
3. **跨平台一致体验**：macOS / Windows 都走相同的「检测 → 弹窗 → 确认 → 下载」流程
4. **不阻断主流程**：更新检测任何环节失败都不能影响主窗口正常使用
5. **可配置**：通过 `config.jsonc` 控制启用 + 通道，便于运维管控
6. **架构可扩展**：未来补 Apple Developer ID 签名后，macOS 也能切到增量更新（无需改架构）

## 设计

### 1. 架构与模块布局

#### 1.1 新增/修改文件清单

```
electron/
  ├── updater.ts          ← 新增：electron-updater 封装 + 状态机 + IPC
  ├── updater.html        ← 新增：更新对话框 UI
  ├── updater.js          ← 新增：更新对话框脚本
  ├── main.ts             ← 改：app.whenReady 内启动 updater
  ├── config.ts           ← 改：增加 autoUpdate + updateChannel 字段
  ├── preload.ts          ← 改：暴露 updater IPC
  └── package.json        ← 改：增加 electron-updater 依赖 + build.publish 配置

scripts/
  └── build-electron.js   ← 改：注释说明 electron-updater bundle 策略

.github/workflows/
  └── build-macos.yml     ← 改：artifact 上传清单增加 latest.yml / latest-mac.yml

config.jsonc             ← 改：示例增加 autoUpdate / updateChannel 字段
README.md                ← 改：新增「🔄 在线更新」章节
BUILD.md                 ← 改：删除 Q6 stub，更新「🎯 建议」，新增「🔄 自动更新机制」
```

#### 1.2 模块依赖关系

```
main.ts
  ├── loadConfig() ─────── 提供 autoUpdate / updateChannel
  └── initUpdater(config)
        ├── electron-updater.autoUpdater.setFeedURL()  ← GitHub Releases
        ├── 检测 + 事件订阅
        ├── showUpdateDialog(info)  ← 创建 BrowserWindow
        │     └── updater.html (preload: window.electronAPI.updater.*)
        └── IPC: updater:download, updater:install, updater:dismiss

updater.html (渲染进程)
  ├── 静态 HTML（版本号、release notes）
  ├── 进度条（download-progress 事件）
  └── 按钮 → IPC → 主进程

GitHub Releases (远端)
  ├── latest.yml (Windows Squirrel 元数据)
  ├── latest-mac.yml (macOS 元数据)
  └── 算粒AI助手-0.5.0-x64-Setup.exe / 算粒AI助手-0.5.0-arm64.dmg
```

#### 1.3 状态机

```
[IDLE] ──init──► [CHECKING] ──无更新──► [IDLE]
                   │
                   ├──有更新──► [NOTIFYING] ──用户点「立即更新」──► [DOWNLOADING]
                   │                              │
                   │                              └─「以后再说」──► [DISMISSED] ──(config.dismissCooldownHours 小时后允许再提示)──► [IDLE]
                   │
                   └──网络错──► [ERROR] ──log 记录──► [IDLE]

[DOWNLOADING] ──完成──► [DOWNLOADED] ──用户点「立即安装」──► [INSTALLING]
                                                          │
                                                          └─ quitAndInstall()
```

### 2. electron-updater 集成与平台差异

#### 2.1 依赖与构建配置

**package.json**：

```json
"devDependencies": {
  "electron-updater": "^6.7.x"
}

"build": {
  "publish": [
    {
      "provider": "github",
      "owner": "hdcljt",
      "repo": "macapp"
    }
  ]
}
```

**scripts/build-electron.js**：

- esbuild 默认 inline bundle 所有 import
- `electron-updater` 是纯 JS，**保持 inline bundle** 进 main.js（体积约 +200KB）
- `external: ['electron']` 保持不变（electron-updater 间接依赖 electron API）

**GitHub Actions**：

- 三个构建 job 保留 `--publish never`（让 release job 统一上传）
- artifact 上传清单增加：
  ```yaml
  release/**/latest.yml          # Windows NSIS metadata
  release/**/latest-mac.yml      # macOS metadata
  ```

#### 2.2 主进程封装 `electron/updater.ts`

```ts
import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import { BrowserWindow, ipcMain, app } from 'electron';
import * as path from 'node:path';
import { logger } from './logger';

const log = logger.child('updater');

export type UpdateChannel = 'stable' | 'beta';

export interface UpdateConfig {
  autoUpdate: boolean;
  updateChannel: UpdateChannel;
  /** dismiss 后静默期（小时）。默认 24；误点可设 0 后重启立刻再提示 */
  dismissCooldownHours: number;
}

let updateWindow: BrowserWindow | null = null;
let updateInfo: UpdateInfo | null = null;
let dismissedVersion: string | null = null;
let lastDismissedAt: number = 0;
let dismissCooldownMs: number = 24 * 60 * 60 * 1000; // 默认 24h，由 config 覆盖

/** 初始化：配置 feed URL + 注册事件 + 注册 IPC */
export function initUpdater(config: UpdateConfig): void {
  if (!config.autoUpdate) {
    log.info('autoUpdate disabled by config');
    return;
  }

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'hdcljt',
    repo: 'macapp',
    channel: config.updateChannel === 'beta' ? 'beta' : 'latest',
  });

  // 关闭自动下载，改为「用户点确认才下载」
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // 事件订阅
  autoUpdater.on('checking-for-update', () => log.info('checking for update'));
  autoUpdater.on('update-available', onUpdateAvailable);
  autoUpdater.on('update-not-available', (info) => log.info(`up to date: ${info.version}`));
  autoUpdater.on('download-progress', onDownloadProgress);
  autoUpdater.on('update-downloaded', onUpdateDownloaded);
  autoUpdater.on('error', (err) => log.error(`updater error: ${err.message}`));

  // 配置静默期
  dismissCooldownMs = config.dismissCooldownHours * 60 * 60 * 1000;
  log.info(`dismiss cooldown: ${config.dismissCooldownHours}h`);

  // IPC handler
  ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate());
  ipcMain.handle('updater:install', () => {
    log.info('user triggered install, quitting...');
    autoUpdater.quitAndInstall(false, true);
  });
  ipcMain.handle('updater:dismiss', (_e, version: string) => {
    dismissedVersion = version;
    lastDismissedAt = Date.now();
    log.info(`user dismissed update ${version}`);
    closeUpdateWindow();
  });

  log.info(`updater initialized: channel=${config.updateChannel}`);
}

/** 启动一次检测（启动时调一次） */
export function checkForUpdates(): void {
  if (dismissedVersion && Date.now() - lastDismissedAt < dismissCooldownMs) {
    log.info(`skipped check, dismissed version ${dismissedVersion} still in cooldown`);
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => log.error(`check failed: ${err.message}`));
}

/** 检测到新版本：弹对话框 */
function onUpdateAvailable(info: UpdateInfo): void {
  log.info(`update available: ${info.version} (current: ${app.getVersion()})`);
  updateInfo = info;
  showUpdateWindow(info);
}
```

#### 2.3 平台差异

| 维度 | macOS (ad-hoc 签名) | Windows (NSIS) |
|------|---------------------|----------------|
| 更新包格式 | DMG / ZIP | NSIS installer |
| 增量差分 | ❌ 不支持（无 Apple Developer ID） | ✅ 支持（electron-updater 内置） |
| 安装方式 | `quitAndInstall` 后**用户手动操作** | `quitAndInstall` 后**自动安装** |
| 替换路径 | `/Applications/算粒AI助手.app`（需用户授权） | `%LOCALAPPDATA%\Programs\算粒AI助手\` |
| electron-updater 行为 | 检测 + 下载 + 弹「请手动替换」说明 | 检测 + 下载 + 自动安装 + 重启 |

**macOS 实际行为**：

- 检测到新版 → 下载 DMG → 弹对话框「新版已下载到 `~/Downloads/算粒AI助手-0.5.0-arm64.dmg`，请退出应用后双击安装」
- 用户点「退出应用」→ 主进程退出 → 用户手动挂载 DMG + 拖入 Applications

**Windows 实际行为**：

- 检测到新版 → 下载 NSIS exe（带 Squirrel 增量） → 弹对话框「新版已下载，点击立即安装」
- 用户点「立即安装」→ `quitAndInstall(false, true)` → 应用退出 → Squirrel 自动替换 + 重启

#### 2.4 GitHub provider 注意事项

- electron-updater 调 GitHub API 拉 latest release 的 `tag_name` + `assets`
- 私有仓库需要 `GH_TOKEN`；本项目是 public，暂不需要
- tag 格式必须是 `v*`（现有 workflow 已匹配 `v*`）

### 3. 更新对话框 UI 与 IPC

#### 3.1 窗口规格

```ts
function showUpdateWindow(info: UpdateInfo): void {
  updateWindow = new BrowserWindow({
    width: 480,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '发现新版本',
    parent: BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined,
    modal: process.platform === 'darwin',
    alwaysOnTop: false,
    skipTaskbar: process.platform === 'darwin',
    backgroundColor: '#FFFFFF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--update-version=${info.version}`,
        `--update-notes=${encodeURIComponent(info.releaseNotes ?? '')}`,
      ],
    },
  });
  updateWindow.setMenuBarVisibility(false);
  updateWindow.loadFile(path.join(__dirname, 'updater.html'));
}
```

#### 3.2 IPC 接口（preload.ts 新增）

```ts
contextBridge.exposeInMainWorld('electronAPI', {
  ...existing,
  updater: {
    download: () => ipcRenderer.invoke('updater:download'),
    install:  () => ipcRenderer.invoke('updater:install'),
    dismiss:  (version: string) => ipcRenderer.invoke('updater:dismiss', version),
    onProgress: (cb: (percent: number) => void) => {
      ipcRenderer.on('updater:progress', (_e, pct: number) => cb(pct));
    },
    onDownloaded: (cb: () => void) => {
      ipcRenderer.on('updater:downloaded', () => cb());
    },
    onError: (cb: (msg: string) => void) => {
      ipcRenderer.on('updater:error', (_e, msg: string) => cb(msg));
    },
  },
});
```

#### 3.3 主进程事件 → 渲染进程 IPC

```ts
autoUpdater.on('download-progress', (progress: ProgressInfo) => {
  log.debug(`progress: ${progress.percent.toFixed(1)}%`);
  updateWindow?.webContents.send('updater:progress', progress.percent);
});

autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
  log.info(`downloaded: ${info.version}`);
  updateWindow?.webContents.send('updater:downloaded');
});

autoUpdater.on('error', (err: Error) => {
  log.error(`updater error: ${err.message}`);
  updateWindow?.webContents.send('updater:error', err.message);
});
```

#### 3.4 `updater.html` 结构

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>发现新版本</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
      padding: 24px;
      margin: 0;
      color: #1d1d1f;
    }
    .version { font-size: 14px; color: #86868b; margin-bottom: 8px; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
    .notes { font-size: 13px; color: #424245; max-height: 120px;
             overflow-y: auto; background: #f5f5f7; padding: 8px 12px;
             border-radius: 6px; white-space: pre-wrap; }
    .progress-bar { width: 100%; height: 4px; background: #e5e5ea;
                    border-radius: 2px; margin-top: 16px; overflow: hidden;
                    display: none; }
    .progress-fill { height: 100%; background: #0071e3; width: 0%;
                     transition: width 0.3s; }
    .actions { display: flex; justify-content: flex-end; gap: 8px;
               margin-top: 20px; }
    button { padding: 6px 14px; border-radius: 6px; border: 1px solid #d2d2d7;
             background: #fff; cursor: pointer; font-size: 13px; }
    button.primary { background: #0071e3; color: #fff; border-color: #0071e3; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="version">v<span id="current"></span> → v<span id="latest"></span></div>
  <h1 id="title">发现新版本</h1>
  <div class="notes" id="notes"></div>
  <div class="progress-bar"><div class="progress-fill" id="fill"></div></div>
  <div class="actions">
    <button id="btn-later">以后再说</button>
    <button id="btn-install" class="primary" style="display:none">立即安装</button>
    <button id="btn-update" class="primary">立即更新</button>
  </div>
  <script src="updater.js"></script>
</body>
</html>
```

#### 3.5 `updater.js` 状态机

```js
const args = process.argv.filter(a => a.startsWith('--update-'));
const get = (k) => {
  const arg = args.find(a => a.startsWith(`--update-${k}=`));
  return arg ? decodeURIComponent(arg.split('=').slice(1).join('=')) : '';
};

document.getElementById('current').textContent = window.electronAPI.versions.app || '?';
document.getElementById('latest').textContent  = get('version');
document.getElementById('notes').textContent    = get('notes') || '本次更新包含若干改进与问题修复。';

const btnUpdate   = document.getElementById('btn-update');
const btnInstall  = document.getElementById('btn-install');
const btnLater    = document.getElementById('btn-later');
const progressBar = document.querySelector('.progress-bar');
const fill = document.getElementById('fill');

window.electronAPI.updater.onProgress((pct) => {
  progressBar.style.display = 'block';
  fill.style.width = pct.toFixed(1) + '%';
});

window.electronAPI.updater.onDownloaded(() => {
  progressBar.style.display = 'none';
  btnUpdate.style.display   = 'none';
  btnInstall.style.display  = 'inline-block';
});

window.electronAPI.updater.onError((msg) => {
  alert('更新失败：' + msg + '\n请前往 GitHub Releases 手动下载。');
});

btnUpdate.addEventListener('click', async () => {
  btnUpdate.disabled = true;
  btnLater.disabled = true;
  await window.electronAPI.updater.download();
});

btnInstall.addEventListener('click', () => {
  window.electronAPI.updater.install();
});

btnLater.addEventListener('click', () => {
  window.electronAPI.updater.dismiss(get('version'));
});
```

#### 3.6 配置字段

`config.jsonc` 新增字段（与现有 7 字段并列）：

```jsonc
{
  ...existing,
  // 是否启用自动更新检测（默认 true）
  "autoUpdate": true,
  // 更新通道：stable / beta
  "updateChannel": "stable",
  // dismiss 后静默期（小时）。误点可改 0 后重启立刻再提示。默认 24
  "dismissCooldownHours": 24
}
```

对应 `AppConfig` interface 新增：

```ts
export interface AppConfig {
  ...existing 7 fields,
  autoUpdate: boolean;
  updateChannel: UpdateChannel;
  dismissCooldownHours: number;
}
```

**校验规则**：

- `dismissCooldownHours` 必须是非负整数（0 立即重新提示；>0 启用静默期）
- 与现有 7 字段同样**硬失败**：缺失或类型错误 → 启动失败（沿用 `validateConfig` 抛 `ConfigValidationError` 流程）

### 4. 错误处理、降级路径与验证流程

#### 4.1 错误矩阵

| 场景 | 触发条件 | 行为 | 用户感知 |
|------|----------|------|----------|
| 网络不可达 | GitHub API 超时 / DNS 失败 | log 记录 + 静默忽略 | 无弹窗 |
| GitHub API 403 | 私有仓库 + 未设 token（理论上不会） | log + 静默 | 无弹窗 |
| 404 latest.yml | tag 刚推但 builder 还没生成 | log + 静默 | 无弹窗 |
| 本地版本 ≥ 最新 | 当前版本已是 latest | log `up to date` | 无弹窗 |
| 签名校验失败（macOS） | macOS Squirrel 差分失败 | fallback 到全量 DMG | 弹「下载中」 |
| 磁盘空间不足 | 下载到一半写盘失败 | log + IPC 推 `updater:error` | 对话框显示失败 |
| 下载中应用退出 | 用户 Cmd+Q | `before-quit` 触发但 `quitAndInstall` 不调 | 文件保留在缓存 |
| 用户点「以后再说」 | dismiss 按钮 | 记录 `dismissedVersion` + 时间戳 | 对话框关闭 |
| 同版本静默期内再启 | dismiss < `dismissCooldownHours` | `checkForUpdates` 跳过 | 不弹窗 |
| 静默期过后再启 | dismiss ≥ `dismissCooldownHours` | 重新检测 | 可能再次弹 |
| 误点 dismiss 想立即再看 | config 设 `dismissCooldownHours: 0` + 重启 | 下次启动不再跳过 | 重新弹窗 |

#### 4.2 不阻断主流程

```ts
// main.ts 中 app.whenReady().then(async () => {
  initLogger();
  registerLogHandlers();

  const config = await loadConfig();
  createMainWindow(config);

  // 更新检测放在最后：任何错误都不能阻断主窗口已启动的状态
  setImmediate(() => {
    try {
      initUpdater({ autoUpdate: config.autoUpdate, updateChannel: config.updateChannel });
      checkForUpdates();
    } catch (err) {
      log.error(`updater init failed: ${(err as Error).message}`);
      // 主窗口已可见，用户正常使用
    }
  });
});
```

**硬原则**：更新检测失败 = 主流程不受影响。

#### 4.3 macOS 全量包降级（ad-hoc 签名场景）

macOS 上 Squirrel 增量更新要求 `hardenedRuntime + notarize`（与现有 ad-hoc 签名不兼容）。electron-updater 在检测到 metadata 但差分失败时**会自动 fallback** 到全量 DMG：

```ts
autoUpdater.on('error', (err) => {
  if (err.message.includes('signature') || err.message.includes('notarize')) {
    log.warn('incremental update failed (ad-hoc signing limitation), fallback to full DMG');
  }
});
```

用户体验差异（macOS）：

```
[检测新版] → [下载 DMG] → [弹窗：已下载到 ~/Downloads/算粒AI助手-0.5.0-arm64.dmg]
 → [退出应用] → [用户手动拖入 Applications]
```

UI 文案区分平台：

```js
const isMac = window.electronAPI.platform === 'darwin';
btnInstall.addEventListener('click', () => {
  if (isMac) {
    alert('更新包已下载到「下载」文件夹。\n请退出应用后双击 .dmg，将「算粒AI助手」拖入「应用程序」文件夹。');
    window.electronAPI.updater.install();
  } else {
    window.electronAPI.updater.install();
  }
});
```

#### 4.4 用户决策的持久化

「以后再说」的状态只存内存（`dismissedVersion` 变量），重启后失效。静默期通过 `config.dismissCooldownHours` 配置：

- 默认 24h
- 误点 dismiss 后想立即再看：将 config 改为 `dismissCooldownHours: 0` 并重启
- 不想被打扰：可设为更大的值（如 168 = 一周）

**MVP 不做磁盘持久化**（写 `userData/update-state.json` 的版本作为「后续可选」）。

#### 4.5 验证流程

**dev 模式验证清单**（`npm run dev:electron`）：

1. 首次启动：日志 `[INFO] [updater] updater initialized: channel=stable`
2. 本地为最新版：日志 `up to date: 0.4.0`，无弹窗
3. 本地落后：弹更新对话框，显示 `v0.3.0 → v0.5.0` + Release Notes
4. 点击「立即更新」：进度条出现 + 数值从 0% 增长到 100%
5. 下载完成：「立即更新」变「立即安装」
6. 点击「立即安装」：主进程退出
7. 点击「以后再说」：对话框关闭，日志 `user dismissed update 0.5.0`
8. 再次启动（< `dismissCooldownHours`）：`skipped check`
9. config 设 `dismissCooldownHours: 0` + 重启 → 立即重新弹窗
10. DevTools console 检查 IPC：所有 `electronAPI.updater.*` 方法可用

**CI 验证清单**（`npm run build:win`）：

10. `release/0.4.0/latest.yml` 存在
11. `release/0.4.0/*.blockmap` 存在
12. `release/0.4.0/*-Setup.exe` 大小 > 80MB

**集成验证清单**（真实环境）：

13. ⚠️ Windows v0.3.0 → 装 v0.4.0 → 启动检测到增量 → 弹窗 → 确认 → 重启
14. ⚠️ macOS v0.3.0 → 装 v0.4.0 → 启动检测到新版 → 弹「手动替换」

#### 4.6 关键日志点

| 事件 | 级别 | 示例 |
|------|------|------|
| `initUpdater` 成功 | INFO | `updater initialized: channel=stable` |
| `autoUpdate` 关闭 | INFO | `autoUpdate disabled by config` |
| 检测中 | INFO | `checking for update` |
| 无更新 | INFO | `up to date: 0.4.0` |
| 检测到新版本 | INFO | `update available: 0.5.0 (current: 0.4.0)` |
| 跳过检测（静默期） | INFO | `skipped check, dismissed version 0.5.0 still in cooldown` |
| 下载开始 | INFO | `user triggered download from dialog` |
| 下载进度 | DEBUG | `progress: 45.2%` |
| 下载完成 | INFO | `downloaded: 0.5.0` |
| 用户 dismiss | INFO | `user dismissed update 0.5.0` |
| 用户安装 | INFO | `user triggered install, quitting...` |
| 错误 | ERROR | `updater error: <message>` |

### 5. GitHub Actions 改动与发布脚本更新

#### 5.1 现有 CI 流程回顾

当前 `.github/workflows/build-macos.yml` 所有构建 job 加 `--publish never`：

- builder **不会**上传产物到 GitHub provider
- builder **仍然生成** latest.yml / latest-mac.yml 到 `release/{version}/`
- 现有 release job 用 `gh release upload` 上传所有 artifact

#### 5.2 metadata 文件生成

electron-builder 在 `nsis`、`mac` target 下自动生成：

| Target | 生成文件 | 客户端用 |
|--------|----------|----------|
| NSIS (Windows) | `latest.yml` | electron-updater (Windows) |
| DMG/ZIP (macOS) | `latest-mac.yml` | electron-updater (macOS) |

现有 `mac.target` 含 `zip` target → 自动生成 `latest-mac.yml`。✅ **无需调整**。

#### 5.3 publish 配置

`package.json.build.publish`：

```json
{
  "provider": "github",
  "owner": "hdcljt",
  "repo": "macapp"
}
```

**作用**：让 builder 知道目标 GitHub 仓库，但**不会自动上传**（仍受 `--publish` 控制）。

#### 5.4 workflow 改动

**`--publish never` 保持不变**（避免 builder 与 gh release 上传冲突）。metadata 仍生成。

**artifact 上传清单增加**：

```yaml
path: |
  release/**/*.dmg
  release/**/*.zip
  release/**/*.blockmap
  release/**/latest.yml          # Windows NSIS metadata
  release/**/latest-mac.yml      # macOS metadata
```

**release job**：现有 `find artifacts -type f` 自动包含新 metadata，**无需额外改动**。

#### 5.5 客户端拉取路径

electron-updater 调 GitHub API：

```
GET https://api.github.com/repos/hdcljt/macapp/releases/latest
```

匹配规则：

| 平台 | 匹配 pattern |
|------|--------------|
| Windows x64 | `*-0.5.0-x64-Setup.exe` |
| macOS arm64 | `*-0.5.0-arm64.dmg` 或 `*-0.5.0-arm64-mac.zip` |

`artifactName` 配置（现有）：

```jsonc
"mac": { "artifactName": "${productName}-${version}-${arch}.${ext}" },
"win": { "artifactName": "${productName}-${version}-${arch}-Setup.${ext}" }
```

匹配规则含 `${arch}`，electron-updater 能正确匹配。✅ **无需调整**。

#### 5.6 公网访问要求

| 检查项 | 状态 |
|--------|------|
| 仓库 public | ✅ |
| Release assets 公开下载 | ✅ |
| API rate limit | 60 次/小时（未认证），够用 |

#### 5.7 发布流程

```bash
git tag v0.5.0
git push origin v0.5.0
```

CI 自动：build → release（含 metadata）。

### 6. README / BUILD.md 文档更新

#### 6.1 README.md 新增章节

在「📋 日志文件」与「🐛 常见问题」之间插入「🔄 在线更新」章节，覆盖：

- 工作流程（启动 → 检测 → 弹窗 → 确认 → 下载/安装）
- 更新源（GitHub Releases）
- 配置更新行为（`autoUpdate` / `updateChannel` / `dismissCooldownHours`）
- 用户选择（立即更新 / 以后再说 + `dismissCooldownHours` 静默）
- macOS 签名说明（ad-hoc → 全量 DMG）
- 调试日志命令
- 关闭自动更新（`autoUpdate: false`）

#### 6.2 BUILD.md 修改

- 删除 Q6 stub（在「🎯 建议」章节已实现）
- 「🎯 建议」章节更新：去掉「配置自动更新」todo，标注「已接入」
- 新增「🔄 自动更新机制」小节：工作原理、平台差异、CI 集成

#### 6.3 config.jsonc 默认值

示例文件新增 `autoUpdate` + `updateChannel` + `dismissCooldownHours` 字段。

#### 6.4 scripts/build-electron.js 注释

注释说明 `electron-updater` inline bundle 策略。

## 范围

本设计**不**包含：

- ❌ 结构化更新日志（接现有 logger）
- ❌ 灰度发布 / A/B 测试通道
- ❌ 更新统计上报
- ❌ 强制更新（用户已选「检查 + 通知 + 确认」）
- ❌ macOS 自动替换（ad-hoc 签名不支持）
- ❌ 更新进度系统通知
- ❌ 「检查更新」菜单项（用户已选「仅启动时检测」）
- ❌ 自动化测试（项目无测试基建）
- ❌ 多语言 Release Notes
- ❌ 离线缓存更新元数据
- ❌ 持久化 dismiss 状态到磁盘

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| macOS ad-hoc 签名无法增量更新 | macOS 每次下完整 DMG | 已确认接受；README 明示 |
| GitHub API rate limit | 60 次/小时瞬时 403 | log 静默；不影响主窗口 |
| electron-updater bundle 体积 | main.js +200KB | 已确认接受 |
| 下载中用户强退 | 部分下载残留 | electron-updater 自动清理 |
| Squirrel Windows 安装失败 | 用户卡在「安装中」 | electron-updater 内置 backup |
| 用户 dismiss 后忘记升级 | 错过重要更新 | `dismissCooldownHours` 后重新提示（默认 24h） |
| tag 与 package.json version 不同步 | metadata 与客户端期望不一致 | CI 校验（可选增强） |
| macOS 模态窗口阻塞主窗口 | 用户被拦截 | 设计预期；用户必须决策 |

## 验收标准

### dev 模式（10 项）

见 §4.5 验证清单第 1-10 项。

### Windows 打包（3 项）

10. `release/0.4.0/latest.yml` + `*.blockmap` 存在
11. GitHub Release 含 `latest.yml` asset
12. v0.3.0 → v0.4.0 增量更新流程通过

### macOS 打包（3 项）

13. `release/0.4.0/latest-mac.yml` 存在
14. GitHub Release 含 `latest-mac.yml` asset
15. v0.3.0 → v0.4.0 全量下载 + 手动替换流程通过

### 配置驱动（5 项）

16. `"autoUpdate": false` → 不检测
17. `"updateChannel": "beta"` → 拉 `v*-beta*` tag
18. config 字段缺失 → 启动失败（沿用硬失败原则）
19. `"dismissCooldownHours": 0` + 误点 dismiss + 重启 → 下次启动立即重新弹窗
20. `"dismissCooldownHours": 168` + dismiss → 一周内不再提示

### 降级路径（5 项）

19. 断网启动：主窗口正常
20. GitHub 403：主窗口正常
21. 磁盘满下载失败：对话框显示失败提示
22. macOS Squirrel 差分失败：fallback 全量
23. 用户强退：缓存保留

## 后续可选

- vitest 测试 updater 模块（mock electron-updater）
- macOS 增量更新（补 Apple Developer ID）
- 「检查更新」菜单项
- 持久化 dismiss 状态到 `userData/update-state.json`
- 强制 major version 升级
- 灰度发布
- 更新失败邮件通知 / Sentry
- delta 压缩 + 国内镜像加速
- Release Notes 多语言

## 决策记录

| 决策 | 选择 | 否决项 |
|------|------|--------|
| 交互模式 | 检查 + 通知 + 用户确认 | 静默下载；强制更新 |
| 更新源 | GitHub Releases | 自建 CDN；复用 targetUrl 后端 |
| 触发时机 | 仅启动时检测 | 仅手动；启动 + 手动 |
| UI 位置 | 独立 BrowserWindow | 内嵌 WebContentsView；原生 dialog |
| macOS 签名 | 保持 ad-hoc + 接受限制 | 补 Apple ID；仅做 Windows |
| 技术选型 | electron-updater | 自研；仅 GitHub API 跳转 |
| 可配置 | config.jsonc 新增字段 | 硬编码 |
| dismiss 持久化 | 仅内存（`dismissCooldownHours` 静默靠时间戳） | 写盘持久化 |
| 静默期配置 | `dismissCooldownHours` 字段（默认 24，误点可改 0） | 写死 24h |
| 测试 | 不引入测试框架 | vitest |
| bundle 策略 | electron-updater inline bundle | external 化 |
| macOS 安装 | 用户手动拖入 | 自动化脚本（ad-hoc 不支持） |
| CI 上传 | 保留 `--publish never`，release job 统一上传 | builder 自动上传 |
| API 凭证 | 不设 GH_TOKEN（public 仓库） | 环境变量 |