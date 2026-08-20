# Application Logger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-dependency logger module that records application startup and key events to `userData/logs/main.log` for cross-platform troubleshooting.

**Architecture:** A new `electron/logger.ts` module exposes a `logger.child('module')` API with sync write + 5MB rotation. Main process replaces key `console.*` calls with logger; preload bridges renderer logs via IPC. Logger failures fall back to console (never block app).

**Tech Stack:** Electron 43, TypeScript 7, esbuild, Node fs APIs (no third-party logger)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `electron/logger.ts` | CREATE | Logger core: child loggers, sync write, rotation, init/close lifecycle, IPC handler registration |
| `electron/main.ts` | MODIFY | Add initLogger/closeLogger calls + replace ~8 key console calls with logger |
| `electron/config.ts` | MODIFY | Replace ~10 console calls with logger (preserve exit-time console.error) |
| `electron/preload.ts` | MODIFY | Add `log: (level, message)` to contextBridge |
| `README.md` | MODIFY | New "日志文件" section: path, format, rotation, examples |

## Task Dependency Graph

```
Task 1 (logger.ts core)        ← standalone
        ↓
Task 2 (main.ts + config.ts)   ← depends on Task 1
        ↓
Task 3 (preload + IPC)         ← depends on Task 2
        ↓
Task 4 (verification)          ← depends on Task 3
        ↓
Task 5 (README)                ← independent, can run anytime after Task 4
```

---

## Task 1: Logger Core Module

**Files:**
- Create: `electron/logger.ts`

**Goal:** Implement the logger module in isolation. No integration yet — just create the file with all functions, then manually exercise it via a small Node script.

### Step 1: Create logger.ts with full implementation

Create file `electron/logger.ts` with the complete content below (~250 lines). This file is self-contained; nothing else in the project imports it yet.

```ts
import { app, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(module: string): Logger;
}

interface State {
  initialized: boolean;
  logFilePath: string | null;
}

const state: State = { initialized: false, logFilePath: null };

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB
const LOG_BASENAME = 'main.log';
const MAX_BACKUPS = 3;

function getLogDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function getLogPath(): string {
  return path.join(getLogDir(), LOG_BASENAME);
}

function getBackupPath(n: number): string {
  return path.join(getLogDir(), `${LOG_BASENAME}.${n}`);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatLine(level: LogLevel, module: string, message: string): string {
  return `${timestamp()} [${level.toUpperCase()}] [${module}] ${message}`;
}

function consoleOutput(level: LogLevel, line: string): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function rotateIfNeeded(): void {
  if (!state.logFilePath) return;
  let size: number;
  try {
    size = fs.statSync(state.logFilePath).size;
  } catch {
    return;
  }
  if (size < MAX_LOG_BYTES) return;

  try {
    if (fs.existsSync(getBackupPath(MAX_BACKUPS))) {
      fs.unlinkSync(getBackupPath(MAX_BACKUPS));
    }
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const from = getBackupPath(i);
      const to = getBackupPath(i + 1);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(state.logFilePath)) {
      fs.renameSync(state.logFilePath, getBackupPath(1));
    }
  } catch (err) {
    console.error(`[logger] rotate failed: ${(err as Error).message}`);
  }
}

function writeRaw(line: string): void {
  if (!state.initialized || !state.logFilePath) return;
  try {
    fs.appendFileSync(state.logFilePath, line + os.EOL);
    rotateIfNeeded();
  } catch (err) {
    console.error(`[logger] write failed: ${(err as Error).message}`);
  }
}

function write(level: LogLevel, module: string, message: string): void {
  const line = formatLine(level, module, message);
  consoleOutput(level, line);
  writeRaw(line);
}

function makeLogger(module: string): Logger {
  return {
    debug: (msg) => write('debug', module, msg),
    info:  (msg) => write('info',  module, msg),
    warn:  (msg) => write('warn',  module, msg),
    error: (msg) => write('error', module, msg),
    child: (sub) => makeLogger(`${module}.${sub}`),
  };
}

export const logger: Logger = makeLogger('app');

export function initLogger(): void {
  if (!app.isReady()) {
    throw new Error('initLogger must be called after app.whenReady()');
  }
  if (state.initialized) return;

  const logDir = getLogDir();
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.error(`[logger] mkdirSync failed: ${(err as Error).message}`);
    return;
  }

  state.logFilePath = getLogPath();
  state.initialized = true;

  rotateIfNeeded();

  const header = `=== log started at ${new Date().toISOString()} (${process.platform}, electron ${process.versions.electron}) ===`;
  writeRaw(header);
  console.log(header);
}

export function closeLogger(): void {
  if (!state.initialized) return;
  const footer = `=== log ended at ${new Date().toISOString()} ===`;
  writeRaw(footer);
  console.log(footer);
}

export function registerLogHandlers(): void {
  ipcMain.handle('log:write', (_event, level: string, message: string) => {
    const rendererLog = logger.child('renderer');
    switch (level) {
      case 'debug': rendererLog.debug(String(message)); break;
      case 'info':  rendererLog.info(String(message));  break;
      case 'warn':  rendererLog.warn(String(message));  break;
      case 'error': rendererLog.error(String(message)); break;
      default:      rendererLog.info(`[level=${level}] ${String(message)}`); break;
    }
  });
}
```

### Step 2: Verify TypeScript compiles

Run: `cd /d:/hudc/git/gitlab/pc/macapp && npx tsc --noEmit`
Expected: zero errors (logger.ts has no other consumers yet).

### Step 3: Smoke test the logger in isolation

Create `scripts/test-logger.js` (temp script, not committed) and run it to verify core behavior:

```js
// scripts/test-logger.js
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.whenReady().then(() => {
  const { initLogger, logger, closeLogger } = require('../electron/logger');
  initLogger();
  const log = logger.child('test');
  log.info('hello from test');
  log.warn('something warned');
  log.error('something errored');
  closeLogger();

  // Verify file exists
  const logFile = path.join(app.getPath('userData'), 'logs', 'main.log');
  console.log('Log file:', logFile);
  console.log('Exists:', fs.existsSync(logFile));
  console.log('Content:');
  console.log(fs.readFileSync(logFile, 'utf-8'));
  app.quit();
});
```

Run: `cd /d:/hudc/git/gitlab/pc/macapp && npx electron scripts/test-logger.js`
Expected:
- Terminal shows 3 log lines with `[INFO] [test]`, `[WARN] [test]`, `[ERROR] [test]`
- File at `<userData>/logs/main.log` exists
- File content starts with `=== log started at ===`, contains the 3 log lines, ends with `=== log ended at ===`

### Step 4: Delete temp test script and commit logger.ts

```bash
cd /d:/hudc/git/gitlab/pc/macapp
rm scripts/test-logger.js
git add electron/logger.ts
git commit -F <(cat <<'EOF'
【需求/缺陷描述】: logger.ts 核心模块
【需求/缺陷单号】: 无
【修改内容】:
- 新增 electron/logger.ts（~250 行）
- 公开 API: logger (顶层), initLogger(), registerLogHandlers(), closeLogger()
- 子 logger API: logger.child('module') 返回新 Logger，支持嵌套 child
- 日志格式: ISO 时间戳 + [LEVEL] + [module] + message
- 写入策略: fs.appendFileSync（同步，不丢日志）
- 轮转: 单文件 5MB 上限 + 3 个备份（main.log.1/2/3），写入后检测
- 兜底: 任何异常 fallback 到 console，不阻断应用
- initLogger 强制要求 app.isReady()
- 启动写 header（包含平台 + electron 版本），退出写 footer
- registerLogHandlers 注册 ipcMain.handle('log:write') 接收渲染进程日志
EOF
)
```

Expected: 1 commit created, logger.ts now exists in the repo. Working tree clean.

---

## Task 2: Integrate logger into main.ts and config.ts

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/config.ts`

**Goal:** Replace key `console.*` calls with `logger.child('module')` while preserving `console.error` for exit-time failures. Add `initLogger`/`closeLogger` lifecycle hooks in main.ts.

### Step 1: Add logger import to main.ts and set up lifecycle

In `electron/main.ts`, find the import block at the top:

```ts
import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron';
import path from 'node:path';

declare const __dirname: string;

import { loadConfig } from './config';
import type { LoadedConfig } from './config';
```

Add logger import after line 8 (`import type { LoadedConfig }`):

```ts
import { logger, initLogger, registerLogHandlers, closeLogger } from './logger';
```

Add a child logger creation right after the module-level `let` declarations (around line 16, after `let loadFailed = false;`):

```ts
const log = logger.child('main');
```

### Step 2: Add initLogger and registerLogHandlers inside whenReady

Find `app.whenReady().then(async () => {` (line 192). Replace the opening:

```ts
app.whenReady().then(async () => {
  const config = await loadConfig();
  createMainWindow(config);
```

With:

```ts
app.whenReady().then(async () => {
  initLogger();
  log.info('app ready');
  registerLogHandlers();
  const config = await loadConfig();
  log.info(`config loaded: ${config.width}x${config.height}`);
  createMainWindow(config);
  log.info(`createMainWindow end: ${config.width}x${config.height}`);
```

### Step 3: Add closeLogger in before-quit hook

Find the `app.on('window-all-closed', ...)` handler at end of file. Add a new handler BEFORE it:

```ts
app.on('before-quit', () => {
  log.info('app quitting');
  closeLogger();
});

app.on('window-all-closed', () => {
```

### Step 4: Replace key console.* calls in createMainWindow

Inside `createMainWindow` function body, replace these specific lines (line numbers approximate; use string match):

| Old | New |
|-----|-----|
| `console.log('[loadURL] content view did-finish-load but load was marked as failed, ignoring');` | `log.debug('content view did-finish-load but load was marked as failed, ignoring');` |
| `console.log('[loadURL] content view did-finish-load, switching to contentView');` | `log.info('content view did-finish-load, switching to contentView');` |
| `console.error(\`[loadURL] ${errorCode} ${errorDescription} url=${validatedURL}\`);` | `log.error(\`content view did-fail-load: ${errorCode} ${errorDescription} url=${validatedURL}\`);` |
| `console.warn(\`[retry ${retryCount}/${MAX_RETRIES}]\`);` | `log.warn(\`retry ${retryCount}/${MAX_RETRIES}\`);` |
| `console.error(\`[loadURL] gave up after ${MAX_RETRIES} retries, switching to error view\`);` | `log.error(\`gave up after ${MAX_RETRIES} retries, switching to error view\`);` |
| `console.error('[render-process-gone]', details);` | `log.error(\`render-process-gone: ${JSON.stringify(details)}\`);` |
| `console.warn(\`[will-navigate blocked] ${url}\`);` | `log.warn(\`will-navigate blocked: ${url}\`);` |
| `console.log('[retry:request] user triggered retry from error view');` | `log.info('user triggered retry from error view');` |

**Note:** All these `console.*` calls happen inside `createMainWindow`, which uses the module-level `log` constant. They do NOT need `const log = logger.child(...)` inside the function.

**Important:** Do NOT replace console calls inside config.ts exit-time paths (Task 2 Step 5 handles config.ts separately with stricter rules).

### Step 5: Update config.ts to use logger

In `electron/config.ts`, add after the existing imports (top of file):

```ts
import { logger } from './logger';
const log = logger.child('config');
```

Replace these `console.log/warn` calls inside `resolveConfigPath()` (around lines 132-139):

| Old | New |
|-----|-----|
| `console.log(\`[config] ✓ 已初始化用户配置: ${userConfigPath}\`);` | `log.info(\`✓ 已初始化用户配置: ${userConfigPath}\`);` |
| `console.warn(\`[config] ⚠ 无法写入 userData: ${(err as Error).message}\`);` | `log.warn(\`⚠ 无法写入 userData: ${(err as Error).message}\`);` |
| `console.warn(\`[config]   回退到 bundled default（用户编辑不会持久化）: ${bundledPath}\`);` | `log.warn(\`回退到 bundled default（用户编辑不会持久化）: ${bundledPath}\`);` |

Replace these `console.log` calls inside `loadConfig()` success path (lines 293-296):

| Old | New |
|-----|-----|
| `console.log(\`[config] ✓ 已加载 ${configPath}\`);` | `log.info(\`✓ 已加载 ${configPath}\`);` |
| `console.log(\`[config]   targetUrl: ${validated.targetUrl}\`);` | `log.info(\`targetUrl: ${validated.targetUrl}\`);` |
| `console.log(\`[config]   窗口: ${validated.width}x${validated.height} (min ${validated.minWidth}x${validated.minHeight})\`);` | `log.info(\`窗口: ${validated.width}x${validated.height} (min ${validated.minWidth}x${validated.minHeight})\`);` |
| `console.log(\`[config]   重试: ${validated.maxRetries} 次, 间隔 ${validated.retryDelayMs}ms\`);` | `log.info(\`重试: ${validated.maxRetries} 次, 间隔 ${validated.retryDelayMs}ms\`);` |

**Critical:** Do NOT replace `console.error` calls in exit paths (ConfigNotFoundError, JSONC parse failure, validation failure, URL parse failure). These run before logger is necessarily initialized AND need synchronous stderr output before `process.exit(1)`. Leave them as `console.error(...)`.

### Step 6: Verify TypeScript compiles

Run: `cd /d:/hudc/git/gitlab/pc/macapp && npx tsc --noEmit`
Expected: zero errors. main.ts and config.ts both type-check.

### Step 7: Verify dev mode smoke test

Run: `cd /d:/hudc/git/gitlab/pc/macapp && rm -f "$(node -e "console.log(require('os').homedir())/Library/Application Support/算粒AI助手/logs/main.log" 2>/dev/null || echo /tmp/none)" && npm run dev:electron`

Simpler approach: just run `npm run dev:electron` and kill it after seeing config loaded.

Expected terminal shows config log lines like:
```
[INFO] [main] app ready
[INFO] [config] ✓ 已加载 /path/to/config.jsonc
[INFO] [config] targetUrl: http://localhost:5195/agent-user/assistant
[INFO] [main] createMainWindow end: 1180x820
```

Then verify the log file was written:
```bash
ls -la "$APPDATA/算粒AI助手/logs/main.log"  # Windows
# or
ls -la ~/Library/Application\ Support/算粒AI助手/logs/main.log  # macOS
```

Expected: file exists, contains header + config lines + main lines + footer (after process exit).

If port 5195 is unreachable, the window may show retry flow — that's OK. Just kill the process after verifying the log file content.

### Step 8: Commit integration

```bash
cd /d:/hudc/git/gitlab/pc/macapp
git add electron/main.ts electron/config.ts
git commit -F <(cat <<'EOF'
【需求/缺陷描述】: main.ts + config.ts 集成 logger
【需求/缺陷单号】: 无
【修改内容】:
- main.ts: 新增 logger 导入 + 模块级 const log = logger.child('main')
- main.ts: app.whenReady() 内调 initLogger()/registerLogHandlers()
- main.ts: 替换 createMainWindow 内 8 处 console.* 为 log.debug/info/warn/error
- main.ts: app.on('before-quit') 新增 closeLogger() 调用 + log.info('app quitting')
- config.ts: 新增 logger 导入 + const log = logger.child('config')
- config.ts: resolveConfigPath() 内 3 处 console.log/warn 替换为 log.*
- config.ts: loadConfig() 成功路径 4 处 console.log 替换为 log.*
- config.ts: 错误退出路径保留 console.error + process.exit(1)（exit 场景下 logger 可能未初始化）
- dev 模式冒烟通过（日志文件正常写入）
EOF
)
```

---

## Task 3: Renderer process integration via preload + IPC

**Files:**
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts` (already has registerLogHandlers call from Task 2; nothing new here)

**Goal:** Expose `window.electronAPI.log(level, message)` so renderer code (splash.html, retry.html, error.html) can write logs to the main log file. The `ipcMain.handle('log:write', ...)` is already registered by `registerLogHandlers()` from Task 2's initLogger flow.

### Step 1: Update preload.ts to expose log API

Find `electron/preload.ts`. Current content:

```ts
import { contextBridge, ipcRenderer } from 'electron';

// 暴露给 splash / retry / error 页面的 API
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  retry: () => ipcRenderer.send('retry:request'),
});
```

Replace with:

```ts
import { contextBridge, ipcRenderer } from 'electron';

// 暴露给 splash / retry / error 页面的 API
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  retry: () => ipcRenderer.send('retry:request'),
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.invoke('log:write', level, message);
  },
});
```

### Step 2: Verify TypeScript compiles

Run: `cd /d:/hudc/git/gitlab/pc/macapp && npx tsc --noEmit`
Expected: zero errors. preload.ts uses the `LogLevel` type implicitly via the union type literal — no import needed since it inlines the literal.

### Step 3: Verify renderer logging via dev mode

Run: `npm run dev:electron`

Wait for the splash window to appear. Open DevTools (right-click → Inspect, or Cmd+Opt+I / Ctrl+Shift+I). In the DevTools console, run:

```js
window.electronAPI.log('info', 'manual test from devtools');
window.electronAPI.log('warn', 'something to warn about');
window.electronAPI.log('error', 'simulated error');
```

Check the log file:
```bash
# Windows
type %APPDATA%\算粒AI助手\logs\main.log
# macOS  
cat ~/Library/Application\ Support/算粒AI助手/logs/main.log
```

Expected to see lines like:
```
[INFO] [renderer] manual test from devtools
[WARN] [renderer] something to warn about
[ERROR] [renderer] simulated error
```

If DevTools is detached (dev mode opens it by default), the window.electronAPI is accessible from there.

Kill the dev process after verification.

### Step 4: Commit preload change

```bash
cd /d:/hudc/git/gitlab/pc/macapp
git add electron/preload.ts
git commit -F <(cat <<'EOF'
【需求/缺陷描述】: preload 暴露 log API
【需求/缺陷单号】: 无
【修改内容】:
- preload.ts contextBridge 新增 log(level, message) 方法
- 内部调 ipcRenderer.invoke('log:write', level, message)
- 主进程 registerLogHandlers（Task 2）已注册 ipcMain.handle('log:write')
- 渲染进程可通过 window.electronAPI.log() 写入主进程日志文件
- dev 模式验证：DevTools console 调 window.electronAPI.log() 后日志文件出现 [LEVEL] [renderer] 行
EOF
)
```

---

## Task 4: End-to-end verification

**Files:** None modified (verification only)

**Goal:** Verify the implementation against spec acceptance criteria #1-13.

### Step 1: dev mode acceptance

Delete any existing log file to start fresh:
```bash
# Windows
del /Q "%APPDATA%\算粒AI助手\logs\main.log*" 2>nul
# macOS
rm -f ~/Library/Application\ Support/算粒AI助手/logs/main.log*
```

Run dev mode:
```bash
cd /d:/hudc/git/gitlab/pc/macapp
npm run dev:electron
```

Wait for splash → contentView transition. Open DevTools console and run:
```js
window.electronAPI.log('info', 'renderer test message');
```

Kill process (Ctrl+C in terminal). Verify acceptance criteria #1-4:

```bash
# Read the log file
# Windows
type "%APPDATA%\算粒AI助手\logs\main.log"
# macOS  
cat ~/Library/Application\ Support/算粒AI助手/logs/main.log
```

Expected content includes:
- Line 1: `=== log started at <ISO> (..., electron 43.4.1) ===`
- Lines with `[INFO] [main] app ready`
- Lines with `[INFO] [config] ✓ 已加载 ...` and 3 more config lines
- Lines with `[INFO] [main] createMainWindow end: 1180x820`
- Lines with `[INFO] [renderer] renderer test message`
- Last line: `=== log ended at <ISO> ===`

If any of these are missing, debug which step is broken before proceeding.

### Step 2: Windows packaging acceptance

Build Windows unpacked dir:
```bash
cd /d:/hudc/git/gitlab/pc/macapp
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npx electron-builder --win --dir
```

Verify release/0.3.3/win-unpacked exists. Then run the packaged exe directly:

```bash
cd /d:/hudc/git/gitlab/pc/macapp/release/0.3.3/win-unpacked
./算粒AI助手.exe
```

(Or on Windows: `算粒AI助手.exe`)

This should run the packaged app with config loading from userData. Wait 3-5 seconds, then close.

Verify acceptance criteria #5-8:
```bash
# Check log file created
type "%APPDATA%\算粒AI助手\logs\main.log"
# Check resources/config.jsonc still bundled (no regression)
ls "%APPDATA%\算粒AI助手\logs\" 2>nul
```

Expected: log file exists, contains header + config load lines + footer.

### Step 3: Rotation test

Generate a large log file to trigger rotation:
```bash
# Windows
echo "padding line for rotation test" >> "%APPDATA%\算粒AI助手\logs\main.log"
# Repeat ~50000 times or write a 6MB file via:
# node -e "require('fs').writeFileSync(process.argv[1], 'x'.repeat(6*1024*1024))" "%APPDATA%\算粒AI助手\logs\main.log"
```

Simpler: use Node to write 6MB directly:
```bash
cd /d:/hudc/git/gitlab/pc/macapp
node -e "
const fs = require('fs');
const path = require('path');
const userData = process.env.APPDATA + '/算粒AI助手/logs/main.log';
fs.writeFileSync(userData, 'x'.repeat(6 * 1024 * 1024));
console.log('Wrote 6MB to:', userData);
"
```

Then restart dev mode:
```bash
npm run dev:electron
```

Wait 3 seconds, kill it. Verify:
```bash
ls -la "%APPDATA%\算粒AI助手\logs/"
```

Expected after rotation:
- `main.log` (current, < 1KB after rotation)
- `main.log.1` (6MB, the pre-rotation content)
- No `main.log.2` or `main.log.3` (didn't exist before)

This verifies acceptance criterion #7.

### Step 4: Fallback test (chmod denial)

Simulate EACCES on the logs directory:
```bash
# Windows (PowerShell, run as admin if possible)
icacls "%APPDATA%\算粒AI助手\logs" /deny "%USERNAME%":(W)
```

Run dev mode:
```bash
npm run dev:electron
```

Expected behavior:
- App still starts (config loads, window opens)
- Terminal shows `[logger] mkdirSync failed: ...` or `[logger] write failed: ...` warnings
- App does NOT crash

Restore permissions after test:
```bash
icacls "%APPDATA%\算粒AI助手\logs" /remove:d "%USERNAME%"
```

This verifies acceptance criterion #11.

### Step 5: Document verification outcomes

No commit needed — verification only. Note any failures for follow-up.

---

## Task 5: Update README

**Files:**
- Modify: `README.md`

**Goal:** Add a "日志文件" section that documents the path, format, rotation policy, and example commands.

### Step 1: Add new section after existing "🐛 常见问题"

Find the line `## 🐛 常见问题` (around line 249 in current README). Insert a new section BEFORE it:

```markdown
## 📋 日志文件

应用启动后会在 `userData/logs/main.log` 写入日志，便于排查启动问题：

- **macOS**：`~/Library/Application Support/算粒AI助手/logs/main.log`
- **Windows**：`%APPDATA%\算粒AI助手\logs\main.log`

### 日志格式

每行格式：`2026-08-21T12:34:56.789 [LEVEL] [module] message`

- 时间戳：本地时区 ISO 8601 毫秒精度
- 级别：`DEBUG` / `INFO` / `WARN` / `ERROR`
- 模块：`main` / `config` / `renderer` 等

每次启动写入 header：`=== log started at <ISO> (<platform>, electron <version>) ===`
进程退出前写入 footer：`=== log ended at <ISO> ===`

### 日志轮转

- 单文件上限 5MB
- 超过时轮转：`main.log` → `main.log.1` → ... → `main.log.3`
- 最老的 `main.log.3` 被丢弃
- 最多保留 3 个备份，总量约 20MB

### 渲染进程日志

渲染进程（splash / retry / error 页面）可通过 `window.electronAPI.log(level, message)` 写入日志，模块名标记为 `renderer`：

```js
window.electronAPI.log('error', 'splash shown after 5s');
```

### 常见用法

```bash
# macOS：查看最新日志
tail -f ~/Library/Application\ Support/算粒AI助手/logs/main.log

# Windows：查看最新日志
type %APPDATA%\算粒AI助手\logs\main.log

# 清空日志（保留目录）
rm ~/Library/Application\ Support/算粒AI助手/logs/main.log*
del "%APPDATA%\算粒AI助手\logs\main.log*"
```

### 故障排查示例

| 现象 | 看什么 |
|------|--------|
| 启动后窗口不显示 | 搜索 `[main] createMainWindow` 和 `[main] app ready` |
| 加载 URL 一直重试 | 搜索 `[main] retry` 或 `[main] did-fail-load` |
| 配置文件加载失败 | 搜索 `[config]` 或 `JSONC 解析失败`（后者保留在 console） |
| 渲染进程报错 | 搜索 `[renderer]` |

## 🐛 常见问题
```

### Step 2: Verify README renders correctly

Open `README.md` in any markdown viewer and check:
- Section header is `## 📋 日志文件`
- New section is positioned before `## 🐛 常见问题`
- No broken markdown formatting
- Code blocks for bash examples render with syntax highlighting

### Step 3: Commit README change

```bash
cd /d:/hudc/git/gitlab/pc/macapp
git add README.md
git commit -F <(cat <<'EOF'
【需求/缺陷描述】: README 新增「日志文件」章节
【需求/缺陷单号】: 无
【修改内容】:
- README 新增「日志文件」章节（在「常见问题」之前）
- 文档化日志文件路径（macOS userData + Windows APPDATA）
- 说明日志格式（时间戳 + 级别 + 模块 + 消息）
- 文档化轮转策略（5MB + 3 备份）
- 新增「渲染进程日志」小节（window.electronAPI.log() 用法）
- 新增「常见用法」小节（macOS tail / Windows type + 清空命令）
- 新增「故障排查示例」表格（4 种常见现象 + 搜索关键字）
EOF
)
```

---

## Self-Review Checklist

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. 架构 | Task 1 |
| 2. API | Task 1 |
| 3. 日志格式 | Task 1 |
| 4. 路径解析 | Task 1 |
| 5. 写入策略 | Task 1 |
| 6. 轮转 | Task 1 + Task 4 verification |
| 7. 主进程接入 | Task 2 |
| 8. 渲染进程接入 | Task 3 |
| 9. 错误处理 | Task 1 (fallback) + Task 4 (chmod test) |
| 10. 初始化顺序 | Task 2 |
| 11. esbuild 配置 | N/A (no change needed, mentioned in spec) |
| 12. 跨平台路径 | Task 4 (Windows packaging) |
| 13. README 章节 | Task 5 |
| 验收 #1-4 (dev) | Task 2 + Task 3 + Task 4 |
| 验收 #5-8 (Windows) | Task 4 |
| 验收 #9-10 (macOS) | Deferred to CI (documented in plan) |
| 验收 #11 (fallback chmod) | Task 4 |
| 验收 #12 (logger init exception) | Task 1 (try/catch in writeRaw) |
| 验收 #13 (IPC before init) | N/A — handler doesn't exist if initLogger not called; renderer invoke will throw but no log written |
| 验收 #14 (README) | Task 5 |

**Placeholder scan:** No "TBD", "TODO", "similar to", or "implement later" in plan steps. All code blocks are complete.

**Type consistency:** `LogLevel = 'debug' | 'info' | 'warn' | 'error'` defined in Task 1, used consistently in preload (inline literal matches), registerLogHandlers (switch case in Task 1), and consoleOutput (level check). All match.

**No Vitest:** Verified — no test framework introduced. Manual verification only per user's explicit constraint.

---

## Final Code Review

After all 5 tasks committed, dispatch a final code-reviewer subagent to verify:
1. All spec requirements met (14 acceptance criteria)
2. logger.ts is self-contained and doesn't leak resources
3. main.ts + config.ts integration is clean (no console calls left where logger should be used)
4. preload.ts exposes only the minimum needed API
5. Rotation works correctly under all 3 acceptance criteria
6. Fallback paths don't throw unhandled errors

Reviewer returns APPROVED / CHANGES_NEEDED. If CHANGES_NEEDED, fix and re-review.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-21-application-logger.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?