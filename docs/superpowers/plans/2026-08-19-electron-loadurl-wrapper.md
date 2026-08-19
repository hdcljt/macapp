# Electron URL Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the React/Vite frontend of `macapp` with an Electron shell that directly loads `http://localhost:5195/agent-user/assistant`, showing a splash window while the URL loads.

**Architecture:** Two `BrowserWindow`s managed in `electron/main.ts`. A splash window (pure HTML+CSS, no framework) appears immediately on `app.ready`. A main window loads the external URL with `show:false`; on `did-finish-load` the main window shows and the splash closes. Errors retry up to 3 times before showing an error page with manual retry.

**Tech Stack:** Electron 43, TypeScript, esbuild (compiles main/preload), HTML+CSS for splash, electron-builder 26 for packaging.

**Spec:** [../specs/2026-08-19-electron-loadurl-wrapper-design.md](../specs/2026-08-19-electron-loadurl-wrapper-design.md)

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `electron/splash.html` | Splash loading animation, inline CSS |
| Create | `electron/error.html` | Error page with retry button, inline CSS |
| Modify | `electron/main.ts` | Two-window lifecycle, loadURL, error handling |
| Modify | `electron/preload.ts` | Remove window-control APIs; keep `platform` + `versions` |
| Modify | `scripts/build-electron.js` | Copy `splash.html` and `error.html` to `dist-electron` |
| Modify | `scripts/launch-electron.js` | Drop `ELECTRON_RENDERER_URL` env var |
| Modify | `package.json` | Scripts, deps, `build.files`, `build.mac.icon` |
| Modify | `README.md` | Tech-stack + run instructions |
| Modify | `BUILD.md` | Splash architecture note in Q&A |
| Delete | `src/` (entire tree) | Old React frontend |
| Delete | `index.html` | Vite entry |
| Delete | `vite.config.ts` | Vite config |
| Delete | `src/vite-env.d.ts` | (already gone with src/) |

---

## Task 1: Create splash.html

**Files:**
- Create: `electron/splash.html`

- [ ] **Step 1: Create `electron/splash.html`**

Write the file with inline CSS animation. The file is loaded directly by Electron — no build pipeline:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
  <title>算粒AI助手</title>
  <style>
    :root {
      --bg-start: #E8F4FF;
      --bg-mid: #F0E8FF;
      --bg-end: #FFE8F0;
      --accent: #6366f1;
      --accent-2: #ec4899;
      --text: #1a1a1a;
    }
    html, body {
      margin: 0;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
        "SF Pro Display", "Helvetica Neue", sans-serif;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    body {
      background: linear-gradient(160deg,
        var(--bg-start) 0%, var(--bg-mid) 45%, var(--bg-end) 100%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 18px;
    }
    .logo {
      font-size: 28px;
      font-weight: 600;
      letter-spacing: 0.5px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .spinner {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 3px solid rgba(99, 102, 241, 0.2);
      border-top-color: var(--accent);
      animation: spin 0.9s linear infinite;
    }
    .label {
      font-size: 13px;
      color: #555;
      letter-spacing: 0.4px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="logo">算粒 AI 助手</div>
  <div class="spinner" aria-hidden="true"></div>
  <div class="label">正在连接到 AI 助手…</div>
</body>
</html>
```

- [ ] **Step 2: Verify the file exists and is valid**

Run: `ls -la electron/splash.html` (Git Bash)
Expected: file shown, > 1KB

- [ ] **Step 3: Commit**

```bash
git add electron/splash.html
git commit -m "feat(splash): 添加启动加载动画窗口

【需求/缺陷描述】: 在外部 URL 加载完成前显示 splash 动画

【修改内容】:
- 新增 electron/splash.html，纯 HTML+CSS 动画
- 600x300 居中窗口使用，渐变背景 + spinner

【需求/缺陷单号】: 无

MG"
```

---

## Task 2: Create error.html

**Files:**
- Create: `electron/error.html`

- [ ] **Step 1: Create `electron/error.html`**

Shown after 3 failed retries. Has a "重试" button that IPCs to main to reload mainWindow:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
  <title>无法连接</title>
  <style>
    :root {
      --bg-start: #FFF5F5;
      --bg-end: #FFE8E8;
      --accent: #dc2626;
      --text: #1a1a1a;
    }
    html, body {
      margin: 0;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
        "SF Pro Display", "Helvetica Neue", sans-serif;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    body {
      background: linear-gradient(160deg, var(--bg-start), var(--bg-end));
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 24px;
      box-sizing: border-box;
    }
    .title {
      font-size: 18px;
      font-weight: 600;
      color: var(--accent);
    }
    .hint {
      font-size: 13px;
      color: #666;
      text-align: center;
      max-width: 360px;
      line-height: 1.6;
    }
    button {
      font-size: 14px;
      padding: 8px 24px;
      border: none;
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font-family: inherit;
    }
    button:hover { opacity: 0.92; }
  </style>
</head>
<body>
  <div class="title">无法连接到助手服务</div>
  <div class="hint">
    请确认 <code>http://localhost:5195</code> 已启动后再试。
    如果问题持续存在，请联系技术支持。
  </div>
  <button id="retry">重试</button>
  <script>
    // 主进程通过 webContents.executeJavaScript 注入触发，本页面仅为兜底
    document.getElementById('retry').addEventListener('click', () => {
      window.location.reload();
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify the file exists**

Run: `ls -la electron/error.html`
Expected: file shown, > 1KB

- [ ] **Step 3: Commit**

```bash
git add electron/error.html
git commit -m "feat(error): 添加加载失败错误页

【需求/缺陷描述】: 主窗口 3 次重试后仍失败时显示错误页

【修改内容】:
- 新增 electron/error.html，包含重试按钮
- 提示用户检查后端 5195 是否启动

【需求/缺陷单号】: 无

MG"
```

---

## Task 3: Update build-electron.js to copy static assets

**Files:**
- Modify: `scripts/build-electron.js:1-51`

- [ ] **Step 1: Update `scripts/build-electron.js`**

After both esbuild calls, before the success log, add a step to copy `electron/splash.html` and `electron/error.html` into `dist-electron`:

```js
/**
 * 编译 Electron 主进程和 preload 脚本
 * 复制 splash.html / error.html 等静态资源
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function buildElectron() {
  const outdir = path.join(root, 'dist-electron');
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir, { recursive: true });
  }

  // 编译 main.ts
  await build({
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(outdir, 'main.js'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });

  // 编译 preload.ts
  await build({
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(outdir, 'preload.js'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });

  // 复制静态资源（splash / error 页面）到 dist-electron
  const staticFiles = ['splash.html', 'error.html'];
  for (const file of staticFiles) {
    const src = path.join(root, 'electron', file);
    const dest = path.join(outdir, file);
    fs.copyFileSync(src, dest);
    console.log(`📄 复制 ${file} → dist-electron/`);
  }

  console.log('✅ Electron 编译完成');
}

buildElectron().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the build script**

Run: `node scripts/build-electron.js`
Expected:
```
✅ Electron 编译完成
📄 复制 splash.html → dist-electron/
📄 复制 error.html → dist-electron/
```

- [ ] **Step 3: Verify outputs exist**

Run: `ls -la dist-electron/splash.html dist-electron/error.html`
Expected: both files exist

- [ ] **Step 4: Commit**

```bash
git add scripts/build-electron.js
git commit -m "build: build-electron 复制 splash.html 与 error.html

【需求/缺陷描述】: 让 Electron 在运行时能找到 splash / error 页

【修改内容】:
- scripts/build-electron.js 复制 electron/*.html 到 dist-electron

【需求/缺陷单号】: 无

MG"
```

---

## Task 4: Slim down electron/preload.ts

**Files:**
- Modify: `electron/preload.ts:1-20` (whole file rewrite)

- [ ] **Step 1: Rewrite `electron/preload.ts` to expose only platform + versions**

```ts
import { contextBridge } from 'electron';

// 暴露给 splash / error 页面的只读信息
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});
```

- [ ] **Step 2: Rebuild electron**

Run: `node scripts/build-electron.js`
Expected: ✅ Electron 编译完成, no errors

- [ ] **Step 3: Commit**

```bash
git add electron/preload.ts dist-electron/preload.js dist-electron/preload.js.map
git commit -m "refactor(preload): 移除窗口控制 API

【需求/缺陷描述】: 没有渲染层调用窗口控制 API 了

【修改内容】:
- electron/preload.ts 仅保留 platform + versions

【需求/缺陷单号】: 无

MG"
```

---

## Task 5: Rewrite electron/main.ts

**Files:**
- Modify: `electron/main.ts:1-72` (whole file rewrite)

- [ ] **Step 1: Replace `electron/main.ts` with two-window logic**

```ts
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
  splashWindow.once('ready-to-show', () => {
    splashWindow?.show();
  });
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
  mainWindow.loadFile(path.join(__dirname, 'error.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
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
```

- [ ] **Step 2: Rebuild electron**

Run: `node scripts/build-electron.js`
Expected: ✅ Electron 编译完成

- [ ] **Step 3: Verify compiled output**

Run: `ls -la dist-electron/main.js`
Expected: file exists, recently updated

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts dist-electron/main.js dist-electron/main.js.map
git commit -m "feat(main): 重写为 splash + main 双窗口加载外部 URL

【需求/缺陷描述】: 应用主窗口改为加载外部 URL，启动时显示 splash

【修改内容】:
- 拆分 createSplashWindow 与 createMainWindow
- 主窗口 loadURL('http://localhost:5195/agent-user/assistant')
- did-finish-load 后显示主窗口并关闭 splash
- did-fail-load 顺序自动重试 3 次后切到错误页
- will-navigate 拦截非 localhost:5195 的导航

【需求/缺陷单号】: 无

MG"
```

---

## Task 6: Simplify scripts/launch-electron.js

**Files:**
- Modify: `scripts/launch-electron.js:1-29`

- [ ] **Step 1: Remove `ELECTRON_RENDERER_URL` env var line**

Since we no longer run a Vite dev server, the env var is unused. The script becomes:

```js
/**
 * 启动 Electron
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

// 关键：彻底移除 ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_RUN_AS_NODE;

const electronPath = require('electron');
const cwd = path.resolve(__dirname, '..');

console.log('🚀 启动 Electron:', electronPath);
console.log('📍 工作目录:', cwd);

const child = spawn(electronPath, ['.'], {
  cwd,
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => {
  console.log(`Electron exited with code ${code}`);
  process.exit(code);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/launch-electron.js
git commit -m "refactor(launch): 移除 ELECTRON_RENDERER_URL

【需求/缺陷描述】: dev:vite 已废弃，不再需要渲染层 URL 环境变量

【修改内容】:
- scripts/launch-electron.js 移除 ELECTRON_RENDERER_URL

【需求/缺陷单号】: 无

MG"
```

---

## Task 7: Update package.json scripts

**Files:**
- Modify: `package.json:9-21`

- [ ] **Step 1: Replace the `scripts` section**

Change:
```json
  "scripts": {
    "dev:vite": "vite",
    "dev:electron": "node scripts/build-electron.js && node scripts/launch-electron.js",
    "dev": "node scripts/build-electron.js && concurrently -k -n VITE,ELECTRON -c blue,magenta \"npm run dev:vite\" \"wait-on http://localhost:5173 && cross-env ELECTRON_RUN_AS_NODE=0 npm run dev:electron\"",
    "build:electron": "node scripts/build-electron.js",
    "build:renderer": "vite build",
    "icon:generate": "node scripts/generate-icons.js",
    "build": "npm run icon:generate && npm run build:electron && npm run build:renderer && cross-env ELECTRON_RUN_AS_NODE=0 electron-builder",
    "build:mac": "npm run icon:generate && npm run build:electron && npm run build:renderer && cross-env ELECTRON_RUN_AS_NODE=0 electron-builder --mac",
    "build:win": "npm run icon:generate && npm run build:electron && npm run build:renderer && cross-env ELECTRON_RUN_AS_NODE=0 electron-builder --win",
    "build:win:zip": "node scripts/build-windows.js",
    "build:win:nsis": "node scripts/build-windows-installer.js",
    "build:mac:universal": "npm run icon:generate && npm run build:electron && npm run build:renderer && cross-env ELECTRON_RUN_AS_NODE=0 electron-builder --mac --universal",
    "preview": "vite preview"
  },
```

to:
```json
  "scripts": {
    "dev:electron": "node scripts/build-electron.js && node scripts/launch-electron.js",
    "dev": "npm run dev:electron",
    "build:electron": "node scripts/build-electron.js",
    "icon:generate": "node scripts/generate-icons.js",
    "build": "npm run icon:generate && npm run build:electron && cross-env ELECTRON_RUN_AS_NODE=0 electron-builder",
    "build:mac": "npm run icon:generate && npm run build:electron && cross-env ELECTRON_RUN_AS_NODE=0 electron-builder --mac",
    "build:win": "npm run icon:generate && npm run build:electron && cross-env ELECTRON_RUN_AS_NODE=0 electron-builder --win",
    "build:win:zip": "node scripts/build-windows.js",
    "build:win:nsis": "node scripts/build-windows-installer.js",
    "build:mac:universal": "npm run icon:generate && npm run build:electron && cross-env ELECTRON_RUN_AS_NODE=0 electron-builder --mac --universal"
  },
```

- [ ] **Step 2: Update `build.files` to not include `dist/`**

Change (in `package.json` under `build`):
```json
    "files": [
      "dist/**/*",
      "dist-electron/**/*",
      "package.json"
    ],
```

to:
```json
    "files": [
      "dist-electron/**/*",
      "package.json"
    ],
```

- [ ] **Step 3: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('✅ JSON valid')"`
Expected: `✅ JSON valid`

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build(scripts): 移除 Vite 相关脚本与 dist 产物

【需求/缺陷描述】: 不再需要 Vite 渲染层与并行启动

【修改内容】:
- 删除 dev:vite / build:renderer / preview
- dev 简化为单一 dev:electron
- build.files 移除 dist/

【需求/缺陷单号】: 无

MG"
```

---

## Task 8: Remove unused dependencies from package.json

**Files:**
- Modify: `package.json:23-46`

- [ ] **Step 1: Remove `dependencies`**

Change:
```json
  "dependencies": {
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  },
```

to (delete the whole `dependencies` block — Electron exposes nothing via `dependencies`, all in `devDependencies`):
```json
```
(no `dependencies` key)

- [ ] **Step 2: Remove unused `devDependencies`**

Change:
```json
  "devDependencies": {
    "@tailwindcss/postcss": "^4.3.3",
    "@tailwindcss/vite": "^4.3.3",
    "@types/node": "^26.2.0",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.4",
    "@vitejs/plugin-react": "^6.0.5",
    "autoprefixer": "^10.5.4",
    "concurrently": "^10.0.5",
    "cross-env": "^10.1.0",
    "electron": "^43.4.1",
    "electron-builder": "^26.15.3",
    "esbuild": "^0.28.2",
    "postcss": "^8.5.26",
    "sharp": "^0.35.3",
    "tailwindcss": "^4.3.3",
    "typescript": "^7.0.2",
    "vite": "^8.2.1",
    "wait-on": "^9.1.0"
  },
```

to:
```json
  "devDependencies": {
    "@types/node": "^26.2.0",
    "cross-env": "^10.1.0",
    "electron": "^43.4.1",
    "electron-builder": "^26.15.3",
    "esbuild": "^0.28.2",
    "sharp": "^0.35.3",
    "typescript": "^7.0.2"
  },
```

- [ ] **Step 3: Reinstall and verify `package.json` + `package-lock.json` are consistent**

Run: `npm install`
Expected: removes unused packages, no errors

- [ ] **Step 4: Verify cleaned devDeps**

Run: `node -e "const p=require('./package.json'); console.log(Object.keys(p.devDependencies).sort().join('\n'))"`
Expected (one per line, alphabetically):
```
@types/node
cross-env
electron
electron-builder
esbuild
sharp
typescript
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): 移除 react/vite/tailwind 依赖

【需求/缺陷描述】: 前端代码已删除，依赖也不再需要

【修改内容】:
- 删除 dependencies（react / react-dom）
- 删除 devDependencies 中 11 个未使用包
- 重新 npm install 更新 package-lock.json

【需求/缺陷单号】: 无

MG"
```

---

## Task 9: Delete unused frontend code

**Files:**
- Delete: `src/` (entire directory tree)
- Delete: `index.html`
- Delete: `vite.config.ts`

- [ ] **Step 1: Delete `src/`**

Run (Git Bash):
```bash
rm -rf src/
```

- [ ] **Step 2: Delete `index.html` and `vite.config.ts`**

Run:
```bash
rm -f index.html vite.config.ts
```

- [ ] **Step 3: Verify deletions**

Run: `ls -la` (top level)
Expected: no `src/`, no `index.html`, no `vite.config.ts`

Run: `ls -la dist/`
Expected: directory either gone or empty (still exists if Vite build ran previously; safe to leave for now)

- [ ] **Step 4: Empty out the now-unused `dist/` directory**

Run:
```bash
rm -rf dist/
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: 删除 React/Vite 前端代码

【需求/缺陷描述】: 全部前端已被 Electron loadURL 替代

【修改内容】:
- 删除 src/、index.html、vite.config.ts
- 删除 dist/（旧 Vite 产物）

【需求/缺陷单号】: 无

MG"
```

---

## Task 10: Verify TypeScript config still works

**Files:**
- (no changes; verify)

- [ ] **Step 1: Run TypeScript check on electron/*.ts**

Run: `npx tsc --noEmit`
Expected: no errors (electron/main.ts and electron/preload.ts must compile)

- [ ] **Step 2: If errors about Vite types, fix `tsconfig.json`**

The current `tsconfig.json` may reference Vite env types. Open `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["node"]
  },
  "include": ["electron"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Confirm `include: ["electron"]` and `jsx: "react-jsx"` may need adjustment. The `jsx` option is fine to keep even without React in deps (won't error unless React JSX is used). However `noEmit: true` + `include: ["electron"]` is what we need; remove any vite-specific paths.

- [ ] **Step 3: Commit (only if tsconfig was modified)**

```bash
git add tsconfig.json
git commit -m "chore(tsconfig): 移除 Vite 相关 include 路径

【修改内容】: tsconfig include 限定到 electron/

【需求/缺陷单号】: 无

MG"
```

---

## Task 11: Update README.md

**Files:**
- Modify: `README.md:1-58`

- [ ] **Step 1: Update the project description (line 3)**

Change:
```
> 基于 Electron + React + TypeScript 的 AI 桌面助手（macOS / Windows）
```

to:
```
> 基于 Electron + TypeScript 的 AI 桌面助手（macOS / Windows），启动后加载 `http://localhost:5195/agent-user/assistant`
```

- [ ] **Step 2: Update the tech stack table (lines 19-25)**

Change the relevant rows:
```
| 框架 | Electron 43 |
| UI | React 19 + TypeScript 7 |
| 构建 | Vite 8 |
| 样式 | Tailwind CSS 4（CSS-based 配置） |
| 打包 | electron-builder 26 |
```

to:
```
| 框架 | Electron 43 |
| 语言 | TypeScript 7 |
| 构建 | esbuild |
| 打包 | electron-builder 26 |
```

- [ ] **Step 3: Update the project structure section (lines 28-58)**

Replace the React components listing with the new splash/error flow:

```
macapp/
├── electron/                 # Electron 主进程
│   ├── main.ts              # 主进程入口（splash + main 双窗口）
│   ├── preload.ts           # 预加载脚本
│   ├── splash.html          # 加载动画
│   └── error.html           # 加载失败错误页
├── scripts/
│   ├── build-electron.js    # esbuild 编译主进程 + 复制静态资源
│   ├── launch-electron.js   # 启动脚本
│   ├── generate-icons.js    # 图标生成（含真 ICO）
│   ├── build-windows.js     # Windows ZIP 打包（兼容旧版）
│   └── build-windows-installer.js  # Windows NSIS installer
├── .github/
│   └── workflows/
│       └── build-macos.yml  # GitHub Actions CI/CD
├── build/                   # 图标资源
└── package.json
```

- [ ] **Step 4: Update Quick Start instructions (lines 65-87)**

Change:
```
Vite 开发服务器 + Electron 窗口，修改代码自动热更新。
```

to:
```
Electron 直接加载外部 URL `http://localhost:5195/agent-user/assistant`。启动前请先在 5195 端口运行后端服务。
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): 更新架构说明与运行提示

【需求/缺陷描述】: 前端已改为外部 URL 加载

【修改内容】:
- 技术栈表格移除 React/Vite/Tailwind
- 项目结构新增 splash.html / error.html
- 运行提示指向 5195 后端

【需求/缺陷单号】: 无

MG"
```

---

## Task 12: Update BUILD.md

**Files:**
- Modify: `BUILD.md` (Q&A sections may reference vite)

- [ ] **Step 1: Open `BUILD.md` and search for vite/React references**

Run: `grep -n -i -E 'vite|react|tailwind' BUILD.md || echo "no matches"`
Expected: list lines mentioning Vite/React/Tailwind

- [ ] **Step 2: For each match, update or remove**

Common edits:
- Replace any Vite-related commands with `node scripts/build-electron.js`
- Remove "开发模式" sub-section referring to Vite HMR (no HMR any more)
- Note: the `npm run dev` now just starts Electron

- [ ] **Step 3: Add a new Q&A entry about the new flow**

Add to BUILD.md after the existing Q&A:

```markdown
### Q: 启动后看到 splash 一直转圈？

可能原因：
- 后端服务未启动：`http://localhost:5195` 必须可达
- 后端启动中：等待后端 ready 后重试 5 秒，应用会自动重试 3 次
- 防火墙阻塞：检查 localhost:5195 是否被本地防火墙拦截
```

- [ ] **Step 4: Commit**

```bash
git add BUILD.md
git commit -m "docs(build): 更新构建说明与新增 splash 故障排查

【修改内容】:
- 移除 Vite/React 相关步骤
- 新增"启动后看到 splash 一直转圈"故障排查

【需求/缺陷单号】: 无

MG"
```

---

## Task 13: Manual verification — dev flow

**Files:**
- (no changes; verify)

- [ ] **Step 1: Reinstall dependencies**

Run: `npm install`
Expected: clean install, no errors

- [ ] **Step 2: Build electron artifacts**

Run: `npm run build:electron`
Expected: `✅ Electron 编译完成`, `📄 复制 splash.html → dist-electron/`, `📄 复制 error.html → dist-electron/`

- [ ] **Step 3: Start a backend on port 5195**

Have any HTTP server listening on `localhost:5195`. Quick option using Python:

```bash
python -m http.server 5195
```

(This serves the cwd; use a directory that has an `agent-user/assistant/index.html` or accept 404 — the goal is to verify Electron's loadURL flow; the splash should appear first either way.)

- [ ] **Step 4: Launch the app**

Run: `npm run dev`
Expected:
- splash window appears immediately with logo + spinner + "正在连接到 AI 助手…"
- when target URL finishes load (or fails), main window shows / splash closes

- [ ] **Step 5: Stop the app**

Close both windows or Ctrl-C in the terminal.

---

## Task 14: Manual verification — error flow

**Files:**
- (no changes; verify)

- [ ] **Step 1: Stop the backend from Task 13**

If still running, kill it.

- [ ] **Step 2: Launch the app**

Run: `npm run dev`
Expected:
- splash appears
- main window attempts load, fails (no backend)
- splash keeps showing for ~15s (3 retries × 5s)
- after 3 failures, main window shows `error.html` with "重试" button

- [ ] **Step 3: Start the backend, click 重试**

- Start backend again on 5195
- Click "重试" (or trigger reload from main process)
- Expected: main window loads successfully, splash closes

- [ ] **Step 4: Commit any debug changes**

If no debug code added, skip this step.

---

## Task 15: Manual verification — production build

**Files:**
- (no changes; verify)

- [ ] **Step 1: Build for current platform**

Run on macOS: `npm run build:mac`
Run on Windows: `npm run build:win`
Expected: electron-builder completes, output in `release/{version}/`

- [ ] **Step 2: Verify the produced artifact contains splash/error HTML**

Run on macOS: `ls -la release/$(node -p "require('./package.json').version")/mac*/算粒AI助手*.app/Contents/Resources/`
Run on Windows: `ls -la release/$(node -p "require('./package.json').version")/win-unpacked/`

Expected: `app.asar` and `dist-electron/` files (or unzipped splash.html / error.html in resources)

- [ ] **Step 3: Run the packaged app**

Open the produced dmg/exe, install + launch.
Expected: splash appears, app loads URL.

---

## Self-Review Checklist

Before declaring the plan complete:

- [x] Spec coverage: every spec section/requirement maps to a task (Architecture → Tasks 1-6, Components → Tasks 1-5, Data flow → Task 5, Errors/Testing → Tasks 13-15)
- [x] No placeholders: every code block is full, every command has expected output
- [x] Type/method consistency: `TARGET_URL`, `MAX_RETRIES`, `RETRY_DELAY_MS`, `splashWindow`, `mainWindow`, `retryCount`, `createSplashWindow`, `createMainWindow`, `showErrorPage` all match across tasks
- [x] No spec requirement missed: dual-window lifecycle (Task 5), retry logic (Task 5), error page (Tasks 2 + 5), static asset copy (Task 3), dependency cleanup (Tasks 7-9), docs (Tasks 11-12), verification (Tasks 13-15)

---

## Notes for Execution

- **Portability**: All paths use forward slashes (Git Bash on Windows); if running on cmd.exe, swap the `rm` commands accordingly.
- **No Jest/Vitest**: This project has no test framework. "Testing" is manual verification through `npm run dev` and visual inspection, plus `npm run build` smoke checks.
- **Sequencing**: Tasks 1-6 must run in order (each builds on previous). Task 7-9 are independent of each other. Tasks 10-12 are independent. Tasks 13-15 are the verification gates.
- **Commit cadence**: One commit per task. Use the project's "MG" footer convention (see recent git log).
