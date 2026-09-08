# opencode 工具列表方案（v1.2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macapp（Electron 桌面壳）实现「写代码」入口的按需工具调度：每次点击弹工具选择 dialog（自渲染 ElDialog 列表），用户选外部 IDE（opencode-ide/codebuddy/kilo-code/zcode/minimax-code）或内嵌 Web（opencode-web/dsh-web），主进程 spawn 对应进程，embedded 嵌入 view，external detached 唤起。

**Architecture:**
- **统一工具列表** 抽象：所有可选工具以同一 schema 登记到 `config.codingAgent.tools`（`type: 'external' | 'embedded'`）。
- **主进程 `codingAgent` 模块**：spawn external / spawn embedded + health check + lifecycle。状态机通过 `subscribe(cb)` 推送到 renderer。
- **Renderer 编排**：点「写代码」→ `openCodingDialog()`：自渲染 ElDialog 列 5 个 tool → 用户点选 → 主进程弹原生 `dialog.showOpenDialog` 选目录 → `openTool(toolId, dir)`。
- **view 切换** 由主进程独占（沿用 `showOnly()` 模式），frontend 只接 `coding:status` 推送 + toast 反馈。

**Tech Stack:** Electron 43 + esbuild CJS + TypeScript 7（主进程）；Vue 3 + Pinia + Element Plus + Vite（offline-app renderer）；Node.js 内置 `child_process.spawn` + `net` 模块。

**Spec 基线:** [docs/superpowers/specs/2026-09-08-opencode-tools-list-design.md](../specs/2026-09-08-opencode-tools-list-design.md)

**非目标：** 自动检测工具是否安装、settings UI（用户可视化编辑 tools）、多 embedded web 同时跑、单元测试框架（项目无 vitest，手动验证）。

---

## 文件结构总览

| 文件 | 状态 | 职责 |
|---|---|---|
| `electron/codingAgent.ts` | 新增 | CodingAgent 类（spawn external/embedded + health + lifecycle + subscribe） |
| `electron/config.ts` | 改造 | 加 `CodingTool` 类型 + `validateCodingTools()` |
| `electron/main.ts` | 改造 | codingView 创建/切换；coding IPC handlers；subscribe 广播；before-quit shutdown |
| `electron/preload.ts` | 改造 | contextBridge 暴露 `window.electronAPI.coding` |
| `config.jsonc` | 改造 | 加 `codingAgent.tools`（5 个外部 IDE + 2 个内嵌 Web） |
| `offline-app/src/types/coding.ts` | 新增 | `CodingTool` + `CodingStatus` 类型镜像 |
| `offline-app/src/coding-toast.ts` | 新增 | `codingToast(status)` 映射 ElMessage |
| `offline-app/src/coding-dialog.ts` | 新增 | `openCodingDialog()` 编排 + 自渲染 `ToolPickerDialog.vue` |
| `offline-app/src/components/ToolPickerDialog.vue` | 新增 | 自渲染 ElDialog 列 tools，emit 选中 tool |
| `offline-app/src/components/FeatureCard.vue` | 改造 | 最小改：保留原 visual，加 `@click="emit('click', card)"` |
| `offline-app/src/components/FeatureSection.vue` | 改造 | 透传 click |
| `offline-app/src/App.vue` | 改造 | 加 `onCardClick`（写代码→openCodingDialog） + `onTabSelect`（code tab→openCodingDialog） |

---

## Task 1: config schema + 校验 + bundled default

**Files:**
- Modify: `electron/config.ts:1-46`（接口追加）
- Modify: `electron/config.ts:157-271`（validateConfig 串接）
- Modify: `config.jsonc`

- [ ] **Step 1: 加 CodingTool 类型**

在 `electron/config.ts` 顶部（line 18 之前）追加：

```ts
export interface CodingToolBase {
  id: string;
  name: string;
  description?: string;
}

export interface ExternalTool extends CodingToolBase {
  type: 'external';
  command: string;
  path?: string;
  args?: string[];
  dirMode: 'positional' | 'cwd' | 'none';
}

export interface EmbeddedTool extends CodingToolBase {
  type: 'embedded';
  command: string;
  args: string[];
  port: number;
  dirMode: 'positional' | 'cwd';
}

export type CodingTool = ExternalTool | EmbeddedTool;

export interface CodingAgentConfig {
  tools: CodingTool[];
}
```

- [ ] **Step 2: 修改 AppConfig**

修改 `electron/config.ts:19-46` 的 AppConfig 末尾追加 `codingAgent: CodingAgentConfig;` 字段。

- [ ] **Step 3: 加 validateCodingTools**

在 `validateConfig`（line 157）之前追加：

```ts
function validateCodingTools(raw: unknown, configPath: string): CodingTool[] {
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(`codingAgent.tools 必须是数组`, configPath);
  }
  if (raw.length === 0) {
    throw new ConfigValidationError('codingAgent.tools 至少要有 1 个工具', configPath);
  }

  const errors: string[] = [];
  const ids = new Set<string>();
  const tools: CodingTool[] = [];

  raw.forEach((rawTool, i) => {
    const tag = `codingAgent.tools[${i}]`;
    if (typeof rawTool !== 'object' || rawTool === null) {
      errors.push(`${tag} 必须是对象`);
      return;
    }
    const t = rawTool as Record<string, unknown>;

    if (typeof t.id !== 'string' || t.id.length === 0) {
      errors.push(`${tag}.id 必须是非空字符串`);
      return;
    }
    if (ids.has(t.id)) { errors.push(`${tag}.id 重复: "${t.id}"`); return; }
    ids.add(t.id);

    if (typeof t.name !== 'string' || t.name.length === 0) {
      errors.push(`${tag}.name 必须是非空字符串`);
    }
    if (t.description !== undefined && typeof t.description !== 'string') {
      errors.push(`${tag}.description 必须是字符串（可选）`);
    }
    if (t.type !== 'external' && t.type !== 'embedded') {
      errors.push(`${tag}.type 必须是 'external' 或 'embedded'`);
      return;
    }
    if (typeof t.command !== 'string' || t.command.length === 0) {
      errors.push(`${tag}.command 必须是非空字符串`);
    }

    if (t.type === 'external') {
      const allowedDir = ['positional', 'cwd', 'none'];
      if (typeof t.dirMode !== 'string' || !allowedDir.includes(t.dirMode)) {
        errors.push(`${tag}.dirMode 必须是 'positional'|'cwd'|'none'`);
      }
      if (t.args !== undefined && !Array.isArray(t.args)) {
        errors.push(`${tag}.args 必须是字符串数组（可选）`);
      }
      if (t.path !== undefined && typeof t.path !== 'string') {
        errors.push(`${tag}.path 必须是字符串（可选）`);
      }
      if (errors.length === 0) {
        tools.push({
          id: t.id, name: t.name,
          ...(t.description !== undefined ? { description: t.description as string } : {}),
          type: 'external', command: t.command,
          ...(t.path !== undefined ? { path: t.path as string } : {}),
          ...(t.args !== undefined ? { args: t.args as string[] } : { args: [] }),
          dirMode: t.dirMode as 'positional' | 'cwd' | 'none',
        });
      }
    } else {
      const allowedDir = ['positional', 'cwd'];
      if (typeof t.dirMode !== 'string' || !allowedDir.includes(t.dirMode)) {
        errors.push(`${tag}.dirMode 必须是 'positional'|'cwd'`);
      }
      if (!Array.isArray(t.args)) errors.push(`${tag}.args 必须是字符串数组`);
      if (!Number.isInteger(t.port) || (t.port as number) < 1 || (t.port as number) > 65535) {
        errors.push(`${tag}.port 必须是 1-65535 的整数`);
      }
      if (errors.length === 0) {
        tools.push({
          id: t.id, name: t.name,
          ...(t.description !== undefined ? { description: t.description as string } : {}),
          type: 'embedded', command: t.command,
          args: t.args as string[], port: t.port as number,
          dirMode: t.dirMode as 'positional' | 'cwd',
        });
      }
    }
  });

  if (errors.length > 0) throw new ConfigValidationError(errors.join('\n  - '), configPath);
  return tools;
}
```

- [ ] **Step 4: validateConfig 串接 codingAgent**

修改 `electron/config.ts:248-271` 的 `useOfflineFallback` 校验之后：

```ts
  if (!('useOfflineFallback' in o)) {
    errors.push('字段 useOfflineFallback 缺失');
  } else if (typeof o.useOfflineFallback !== 'boolean') {
    errors.push(`useOfflineFallback 必须是 boolean`);
  }

  // codingAgent（v1.2 新增）
  let validatedTools: CodingTool[] = [];
  if (!('codingAgent' in o) || !o.codingAgent) {
    errors.push('字段 codingAgent 缺失');
  } else {
    validatedTools = validateCodingTools(
      (o.codingAgent as Record<string, unknown>).tools, configPath
    );
  }

  if (errors.length > 0) throw new ConfigValidationError(errors.join('\n  - '), configPath);

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
    useOfflineFallback: o.useOfflineFallback as boolean,
    codingAgent: { tools: validatedTools },
  };
}
```

- [ ] **Step 5: 更新 bundled config**

在 `config.jsonc` 末尾追加（保留原所有字段 + 注释）：

```jsonc
  // 编码工具列表（v1.2 新增）
  // 每次点"写代码"会弹 dialog 列出这些工具，用户选一个后弹目录选择 dialog
  // type: external ─► spawn detached，外部 IDE 接管
  // type: embedded ─► spawn 内嵌 web 服务，主进程加载到 codingView
  "codingAgent": {
    "tools": [
      {
        "id": "opencode-ide",
        "name": "OpenCode IDE",
        "type": "external",
        "command": "opencode",
        "args": [],
        "dirMode": "positional"
      },
      {
        "id": "codebuddy",
        "name": "CodeBuddy",
        "type": "external",
        "command": "codebuddy",
        "args": [],
        "dirMode": "positional"
      },
      {
        "id": "kilo-code",
        "name": "Kilo Code",
        "type": "external",
        "command": "kilo",
        "args": [],
        "dirMode": "positional"
      },
      {
        "id": "zcode",
        "name": "ZCode",
        "type": "external",
        "command": "zcode",
        "args": [],
        "dirMode": "positional"
      },
      {
        "id": "minimax-code",
        "name": "MiniMax Code",
        "type": "external",
        "command": "minimax-code",
        "args": [],
        "dirMode": "positional"
      },
      {
        "id": "opencode-web",
        "name": "OpenCode Web",
        "description": "内嵌 opencode-ai Web UI",
        "type": "embedded",
        "command": "npx",
        "args": ["opencode-ai", "web", "--port", "<port>", "--hostname", "127.0.0.1"],
        "port": 4296,
        "dirMode": "cwd"
      },
      {
        "id": "dsh-web",
        "name": "DeepSeek DSH",
        "description": "内嵌 @deepseek-ai/dsh Web UI",
        "type": "embedded",
        "command": "npx",
        "args": ["@deepseek-ai/dsh", "web", "--port", "<port>", "--hostname", "127.0.0.1"],
        "port": 4297,
        "dirMode": "cwd"
      }
    ]
  }
```

- [ ] **Step 6: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

- [ ] **Step 7: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
【需求/缺陷描述】: v1.2 config schema 接入 codingAgent.tools
【需求/缺陷单号】: 无
【修改内容】:
- electron/config.ts: 加 CodingTool/EmbeddedTool/ExternalTool/CodingAgentConfig 类型；加 validateCodingTools() 校验数组+必填+id 唯一+dirMode 范围；validateConfig 末尾串接 codingAgent 校验
- config.jsonc: bundled default 加 codingAgent.tools（5 外部 IDE：opencode-ide/codebuddy/kilo-code/zcode/minimax-code；2 内嵌 Web：opencode-web/dsh-web）
EOF
git add electron/config.ts config.jsonc
git commit -F /tmp/commit-msg.txt
```

---

## Task 2: codingAgent 模块（external + embedded + health + lifecycle）

**Files:**
- Create: `electron/codingAgent.ts`

- [ ] **Step 1: 模块顶部 + 类型**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { logger } from './logger';
import type { CodingTool, CodingAgentConfig } from './config';

const log = logger.child('coding');

export type CodingStatus =
  | { state: 'idle' }
  | { state: 'launching-external'; toolId: string }
  | { state: 'spawning-embedded'; toolId: string }
  | { state: 'ready-embedded'; url: string; toolId: string }
  | { state: 'spawn-failed'; message: string }
  | { state: 'timeout' }
  | { state: 'exited'; code: number; toolId: string };

export type CodingOpenResult =
  | { ok: true; url?: string }
  | { ok: false; reason: 'unknown-tool' | 'spawn-failed' | 'timeout'; message: string };

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(preferred: number): Promise<number | null> {
  for (let p = preferred; p < preferred + 5; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

function buildArgs(template: string[], dir: string, dirMode: 'positional' | 'cwd' | 'none', port: number): string[] {
  const result = template.map((arg) => arg === '<port>' ? String(port) : arg);
  if (dirMode === 'positional') result.push(dir);
  return result;
}
```

- [ ] **Step 2: CodingAgent 类骨架 + subscribe/emit/getStatus**

```ts
export class CodingAgent {
  private status: CodingStatus = { state: 'idle' };
  private child: ChildProcess | null = null;
  private currentToolId: string | null = null;
  private listeners = new Set<(s: CodingStatus) => void>();

  constructor(private cfg: CodingAgentConfig) {}

  subscribe(cb: (s: CodingStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getStatus(): CodingStatus { return this.status; }
  getInitialStatus(): Promise<CodingStatus> { return Promise.resolve(this.status); }

  private emit(next: CodingStatus): void {
    this.status = next;
    log.debug(`status: ${JSON.stringify(next)}`);
    for (const cb of this.listeners) {
      try { cb(next); } catch (err) { log.warn(`subscriber error: ${(err as Error).message}`); }
    }
  }

  async openTool(tool: CodingTool, dir: string): Promise<CodingOpenResult> {
    if (tool.type === 'external') return this.spawnExternal(tool, dir);
    return this.spawnEmbedded(tool, dir);
  }
}
```

- [ ] **Step 3: spawnExternal（含失败修）**

```ts
  /** external：spawn detached + shell:false；失败（spawn throw 或 async error）→ return ok:false */
  private spawnExternal(tool: import('./config').ExternalTool, dir: string): CodingOpenResult {
    this.currentToolId = tool.id;

    const args: string[] = [];
    if (tool.args) args.push(...tool.args);
    if (tool.dirMode === 'positional') args.push(dir);

    const cmd = tool.path && tool.path.length > 0 ? tool.path : tool.command;
    const cwd = tool.dirMode === 'cwd' ? dir : process.cwd();

    log.info(`spawn external: ${cmd} ${args.join(' ')} (cwd=${cwd})`);

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        detached: true, stdio: 'ignore', cwd, shell: false,
      });
    } catch (err) {
      // spawn 同步 throw（如命令路径非法、权限不足）
      const message = (err as Error).message;
      log.error(`external spawn threw: ${message}`);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }

    // 监听 async 'error' 事件（如 PATH 找不到、ENOENT）
    let resolved = false;
    child.on('error', (err) => {
      if (resolved) return; // spawn 成功后 detached 不再上报
      resolved = true;
      log.warn(`external spawn error: ${err.message}`);
      this.emit({ state: 'spawn-failed', message: err.message });
    });
    child.on('spawn', () => {
      if (resolved) return;
      resolved = true;
      child.unref();
      this.emit({ state: 'launching-external', toolId: tool.id });
      // external 完成后回到 idle（macapp 不跟踪 detached 进程）
      setImmediate(() => this.emit({ state: 'idle' }));
    });

    return { ok: true };
  }
```

- [ ] **Step 4: spawnEmbedded（含 port/health/lifecycle）**

```ts
  /** embedded：spawn + health check + 等待就绪或超时；运行中 exit 上报 */
  private async spawnEmbedded(tool: import('./config').EmbeddedTool, dir: string): Promise<CodingOpenResult> {
    this.currentToolId = tool.id;

    const port = await pickPort(tool.port);
    if (port === null) {
      const message = `端口 ${tool.port}~${tool.port + 4} 全部被占`;
      log.error(message);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }

    const args = buildArgs(tool.args, dir, tool.dirMode, port);
    const cwd = tool.dirMode === 'cwd' ? dir : process.cwd();

    log.info(`spawn embedded: ${tool.command} ${args.join(' ')} (port=${port}, cwd=${cwd})`);

    let child: ChildProcess;
    try {
      child = spawn(tool.command, args, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env, PORT: String(port) },
      });
    } catch (err) {
      const message = (err as Error).message;
      log.error(`embedded spawn threw: ${message}`);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }

    this.child = child;

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text.length > 0) log.warn(`[${tool.id} stderr] ${text.slice(-4096)}`);
    });

    this.emit({ state: 'spawning-embedded', toolId: tool.id });

    child.on('exit', (code, signal) => {
      log.info(`embedded exit: code=${code} signal=${signal}`);
      this.child = null;
      if (code === 0 || code === null) {
        this.emit({ state: 'idle' });
      } else {
        this.emit({ state: 'exited', code: code ?? -1, toolId: this.currentToolId ?? tool.id });
      }
    });

    const ready = await this.healthCheck(port, 5000);
    if (!ready) {
      log.error(`health check timeout: port=${port}`);
      this.child?.kill('SIGTERM');
      this.emit({ state: 'timeout' });
      setImmediate(() => this.emit({ state: 'idle' }));
      return { ok: false, reason: 'timeout', message: '工具启动超时（5s 未就绪）' };
    }

    const url = `http://127.0.0.1:${port}`;
    log.info(`embedded ready: ${url}`);
    this.emit({ state: 'ready-embedded', url, toolId: tool.id });
    return { ok: true, url };
  }

  private async healthCheck(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch { /* 连接拒绝/超时，继续轮询 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  shutdown(): void {
    if (!this.child || this.child.killed) return;
    log.info('shutdown: killing embedded child');
    this.child.kill('SIGTERM');
    const start = Date.now();
    while (this.child && !this.child.killed && Date.now() - start < 2000) { /* spin */ }
    if (this.child && !this.child.killed) {
      log.warn('shutdown: SIGTERM timeout, sending SIGKILL');
      this.child.kill('SIGKILL');
    }
  }
```

- [ ] **Step 5: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

- [ ] **Step 6: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
【需求/缺陷描述】: codingAgent 模块（external失败修 + embedded + health + lifecycle）
【需求/缺陷单号】: 无
【修改内容】:
- electron/codingAgent.ts（新增）:
  - 类型：CodingStatus 7 state + CodingOpenResult (ok/err, no dialog-cancelled)
  - 工具：isPortFree (net.createServer) / pickPort (preferred~+5 探测) / buildArgs (占位符+dir 追加)
  - CodingAgent 类：subscribe/getStatus/getInitialStatus/emit + openTool
  - spawnExternal：spawn detached + stdio:ignore + shell:false；用 child.on('spawn') 成功后才 return ok:true；'error' 异步触发时若还没 resolved 则上报 spawn-failed（修原版本 detached 后状态丢失的 bug）
  - spawnEmbedded：pickPort → spawn + PORT env + pipe stdio → emit spawning-embedded → child.on('exit')（code=0 回 idle；code≠0 上报 exited）→ healthCheck 5s → ready-embedded / timeout
  - shutdown：SIGTERM → 自旋 2s → 还在则 SIGKILL
EOF
git add electron/codingAgent.ts
git commit -F /tmp/commit-msg.txt
```

---

## Task 3: main.ts 集成（codingView + IPC + before-quit）

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: 加 import + 全局变量**

修改 `electron/main.ts:1-23`：

```ts
import { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

declare const __dirname: string;

import { loadConfig } from './config';
import type { LoadedConfig } from './config';
import { logger, initLogger, registerLogHandlers, closeLogger } from './logger';
import { initUpdater, checkForUpdates } from './updater';
import { CodingAgent, type CodingStatus } from './codingAgent';

let mainWindow: BrowserWindow | null = null;

let loadingView: WebContentsView | null = null;
let retryView: WebContentsView | null = null;
let errorView: WebContentsView | null = null;
let offlineView: WebContentsView | null = null;
let contentView: WebContentsView | null = null;
let codingView: WebContentsView | null = null;  // v1.2 新增

let retryCount = 0;
let loadFailed = false;
let offlineReady = false;
let codingAgent: CodingAgent | null = null;  // v1.2 新增

const log = logger.child('main');
```

- [ ] **Step 2: showOnly + allViews 纳入 codingView**

修改 `electron/main.ts:30-43`：

```ts
function showOnly(view: WebContentsView | null) {
  loadingView?.setVisible(view === loadingView);
  retryView?.setVisible(view === retryView);
  errorView?.setVisible(view === errorView);
  offlineView?.setVisible(view === offlineView);
  contentView?.setVisible(view === contentView);
  codingView?.setVisible(view === codingView);
}

function allViews(): WebContentsView[] {
  return [loadingView, retryView, errorView, offlineView, contentView, codingView]
    .filter((v): v is WebContentsView => v !== null);
}
```

- [ ] **Step 3: 加 createCodingView + showCodingView**

在 `createUrlView`（line 104）之后追加：

```ts
/** codingView：独立白名单 http://127.0.0.1:<urlPort>/*；其它导航 prevent */
function createCodingView(url: string): WebContentsView {
  const urlPort = new URL(url).port;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
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

function showCodingView(url: string): void {
  if (!codingView) codingView = createCodingView(url);
  else codingView.webContents.loadURL(url);
  showOnly(codingView);
}
```

- [ ] **Step 4: registerIpcHandlers 加 coding handlers**

修改 `electron/main.ts:344-367` 的 `registerIpcHandlers` 签名：

```ts
function registerIpcHandlers(mode: 'offline-first' | 'legacy', config: LoadedConfig) {
  if (mode === 'legacy') {
    ipcMain.on('retry:request', () => {
      log.info('user triggered retry from error view');
      retryCount = 0; loadFailed = false;
      showOnly(loadingView);
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.reload();
      }
    });
  } else {
    ipcMain.on('online:retry', () => {
      log.info('user triggered retry from offline view TopBar');
      loadFailed = false;
      emitLoadingState('show');
      if (contentView && !contentView.webContents.isDestroyed()) {
        contentView.webContents.reload();
      }
    });
  }

  // v1.2: coding handlers
  ipcMain.handle('coding:list-tools', () => config.codingAgent.tools);

  ipcMain.handle('coding:choose-directory', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'], title: '选择项目目录',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('coding:open-tool', async (_e, toolId: string, dir: string) => {
    if (!codingAgent) return { ok: false, reason: 'spawn-failed', message: 'codingAgent 未初始化' };
    const tool = config.codingAgent.tools.find((t) => t.id === toolId);
    if (!tool) return { ok: false, reason: 'unknown-tool', message: `未找到工具: ${toolId}` };
    const result = await codingAgent.openTool(tool, dir);
    if (result.ok && result.url && tool.type === 'embedded') {
      showCodingView(result.url);
    }
    return result;
  });

  ipcMain.on('coding:close', () => {
    log.info('user triggered close coding view');
    showOnly(offlineView ?? contentView);
  });

  ipcMain.handle('coding:status', () => codingAgent?.getStatus() ?? { state: 'idle' });
}
```

- [ ] **Step 5: app.whenReady 串接**

修改 `electron/main.ts:374-377`：

```ts
  const config = await loadConfig();
  log.info(`config loaded: ${config.width}x${config.height}`);
  registerIpcHandlers(
    config.useOfflineFallback ? 'offline-first' : 'legacy',
    config,
  );
  // v1.2: 创建 codingAgent + subscribe 推送
  codingAgent = new CodingAgent(config.codingAgent);
  codingAgent.subscribe((status: CodingStatus) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('coding:status', status);
    }
  });
  createMainWindow(config);
```

- [ ] **Step 6: before-quit shutdown**

修改 `electron/main.ts:401-404`：

```ts
app.on('before-quit', () => {
  log.info('app quitting');
  codingAgent?.shutdown();
  closeLogger();
});
```

- [ ] **Step 7: 编译验证 + Commit**

Run: `npm run build:electron` → 期望编译成功。

```bash
cat > /tmp/commit-msg.txt <<'EOF'
【需求/缺陷描述】: main.ts 接入 codingAgent + codingView + coding IPC handlers
【需求/缺陷单号】: 无
【修改内容】:
- electron/main.ts:
  - 加 codingView 全局；showOnly/allViews 纳入
  - 加 createCodingView（独立白名单 http://127.0.0.1:<urlPort>/*）
  - 加 showCodingView：codingView 不存在则创建，否则 reloadURL；showOnly(codingView)
  - registerIpcHandlers 加 coding handlers：list-tools / choose-directory / open-tool / close / status
  - coding:open-tool embedded 时自动 showCodingView(result.url)
  - coding:close 切回 offlineView（fallback contentView）
  - app.whenReady：先 registerIpcHandlers(..., config) 再 new CodingAgent + subscribe 推到所有 BrowserWindow
  - before-quit：codingAgent?.shutdown()（同步 ≤2s）
EOF
git add electron/main.ts
git commit -F /tmp/commit-msg.txt
```

---

## Task 4: preload.ts coding namespace

**Files:**
- Modify: `electron/preload.ts:11-62`

- [ ] **Step 1: 加 coding namespace**

修改 `electron/preload.ts`，在 `updater: { ... },` 之后、`});` 之前追加：

```ts
  coding: {
    listTools: (): Promise<unknown[]> => ipcRenderer.invoke('coding:list-tools'),
    openTool: (
      toolId: string, dir: string,
    ): Promise<{ ok: boolean; url?: string; reason?: string; message?: string }> =>
      ipcRenderer.invoke('coding:open-tool', toolId, dir),
    chooseDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke('coding:choose-directory'),
    close: (): void => ipcRenderer.send('coding:close'),
    onStatus: (cb: (status: unknown) => void): (() => void) => {
      const listener = (_e: unknown, status: unknown) => cb(status);
      ipcRenderer.on('coding:status', listener);
      return () => ipcRenderer.removeListener('coding:status', listener);
    },
    getInitialStatus: (): Promise<unknown> => ipcRenderer.invoke('coding:status'),
  },
```

- [ ] **Step 2: 编译验证 + Commit**

Run: `npm run build:electron` → 期望编译成功。

```bash
cat > /tmp/commit-msg.txt <<'EOF'
【需求/缺陷描述】: preload.ts 暴露 window.electronAPI.coding
【需求/缺陷单号】: 无
【修改内容】:
- electron/preload.ts: contextBridge 增加 coding namespace（listTools/openTool/chooseDirectory/close/onStatus/getInitialStatus）；onStatus 返回 unsubscribe
EOF
git add electron/preload.ts
git commit -F /tmp/commit-msg.txt
```

---

## Task 5: offline-app 全集成（types + toast + 自渲染 dialog + App.vue + FeatureCard）

**Files:**
- Create: `offline-app/src/types/coding.ts`
- Create: `offline-app/src/coding-toast.ts`
- Create: `offline-app/src/coding-dialog.ts`
- Create: `offline-app/src/components/ToolPickerDialog.vue`
- Modify: `offline-app/src/components/FeatureCard.vue`（最小改）
- Modify: `offline-app/src/components/FeatureSection.vue`（透传 click）
- Modify: `offline-app/src/App.vue`

- [ ] **Step 1: types/coding.ts（类型镜像，无 type guards）**

```ts
export type DirMode = 'positional' | 'cwd' | 'none';

export interface CodingToolBase { id: string; name: string; description?: string; }
export interface ExternalTool extends CodingToolBase {
  type: 'external'; command: string; path?: string; args?: string[]; dirMode: DirMode;
}
export interface EmbeddedTool extends CodingToolBase {
  type: 'embedded'; command: string; args: string[]; port: number; dirMode: Exclude<DirMode, 'none'>;
}
export type CodingTool = ExternalTool | EmbeddedTool;

export type CodingStatus =
  | { state: 'idle' }
  | { state: 'launching-external'; toolId: string }
  | { state: 'spawning-embedded'; toolId: string }
  | { state: 'ready-embedded'; url: string; toolId: string }
  | { state: 'spawn-failed'; message: string }
  | { state: 'timeout' }
  | { state: 'exited'; code: number; toolId: string };
```

- [ ] **Step 2: coding-toast.ts**

```ts
import { ElMessage } from 'element-plus';
import type { CodingStatus } from '@/types/coding';

export function codingToast(status: CodingStatus): void {
  switch (status.state) {
    case 'launching-external':
      ElMessage.info('正在启动外部 IDE…', { duration: 2000, grouping: true });
      break;
    case 'spawning-embedded':
      ElMessage.info('正在启动内嵌工具…', { duration: 0, grouping: true });
      break;
    case 'ready-embedded':
      ElMessage.closeAll();
      break;
    case 'spawn-failed':
      ElMessage.error(`启动失败：${status.message}`, { duration: 4000 });
      break;
    case 'timeout':
      ElMessage.error('工具启动超时（5s 未就绪）', { duration: 4000 });
      break;
    case 'exited':
      ElMessage.error(`工具已退出（code=${status.code}）`, { duration: 4000 });
      break;
    case 'idle':
      break;
  }
}
```

- [ ] **Step 3: ToolPickerDialog.vue（自渲染 ElDialog 列 tools）**

```vue
<script setup lang="ts">
/**
 * ToolPickerDialog — 自渲染 ElDialog 列出所有 codingAgent.tools
 * 用户点 tool 按钮 → emit('select', tool)；点取消 → emit('cancel')。
 */
import type { CodingTool } from '@/types/coding'

defineProps<{
  visible: boolean
  tools: CodingTool[]
}>()

const emit = defineEmits<{
  select: [tool: CodingTool]
  cancel: []
}>()

function badge(type: CodingTool['type']): string {
  return type === 'embedded' ? '🌐 内嵌' : '🚀 外部'
}
</script>

<template>
  <ElDialog
    :model-value="visible"
    title="选择编码工具"
    width="480px"
    :show-close="true"
    :close-on-click-modal="true"
    @update:model-value="(v: boolean) => { if (!v) emit('cancel') }"
  >
    <div class="tool-list">
      <button
        v-for="tool in tools"
        :key="tool.id"
        type="button"
        class="tool-btn"
        @click="emit('select', tool)"
      >
        <div class="tool-row">
          <span class="tool-badge">{{ badge(tool.type) }}</span>
          <span class="tool-name">{{ tool.name }}</span>
        </div>
        <div v-if="tool.description" class="tool-desc">{{ tool.description }}</div>
      </button>
    </div>
  </ElDialog>
</template>

<style lang="scss" scoped>
.tool-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-btn {
  padding: 12px 16px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #ffffff;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition: background-color 150ms, border-color 150ms;

  &:hover {
    background: #f9fafb;
    border-color: #93c5fd;
  }
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-badge {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 6px;
  background: #eff6ff;
  color: #2563eb;
}

.tool-name {
  font-size: 14px;
  font-weight: 600;
}

.tool-desc {
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}
</style>
```

- [ ] **Step 4: coding-dialog.ts（编排 + 订阅 toast）**

```ts
import { ref, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import type { CodingTool, CodingStatus } from '@/types/coding';
import { codingToast } from '@/coding-toast';

/**
 * 工具选择 dialog 的可见性 + 选中的 tool。
 * 在 App.vue setup() 里 create 一个 module-scope 的 reactive 状态，
 * 让 openCodingDialog() 和 ToolPickerDialog.vue 共享。
 */
const visible = ref(false);
const tools = ref<CodingTool[]>([]);

let unsubscribeStatus: (() => void) | null = null;

export function initCodingDialog() {
  if (!window.electronAPI) return;
  // 取 initial status
  window.electronAPI.coding.getInitialStatus().then((raw) => {
    if (raw && typeof raw === 'object' && 'state' in (raw as object)) {
      codingToast(raw as CodingStatus);
    }
  });
  // 订阅 status
  unsubscribeStatus = window.electronAPI.coding.onStatus((raw) => {
    if (raw && typeof raw === 'object' && 'state' in (raw as object)) {
      codingToast(raw as CodingStatus);
    }
  });
}

export function disposeCodingDialog() {
  unsubscribeStatus?.();
  unsubscribeStatus = null;
}

/** 用户点"写代码" → 主流程入口 */
export async function openCodingDialog(): Promise<void> {
  if (!window.electronAPI) {
    console.log('[coding] openCodingDialog (dev mode, no IPC)');
    return;
  }

  let list: unknown[];
  try {
    list = await window.electronAPI.coding.listTools();
  } catch (err) {
    ElMessage.error(`读取工具列表失败：${(err as Error).message}`);
    return;
  }
  if (!Array.isArray(list) || list.length === 0) {
    ElMessage.warning('未配置任何编码工具，请编辑 config.jsonc');
    return;
  }
  tools.value = list as CodingTool[];
  visible.value = true;
}

/** ToolPickerDialog 选完一个 tool 后的回调 */
export async function onToolPicked(tool: CodingTool): Promise<void> {
  visible.value = false;
  if (!window.electronAPI) return;

  let dir: string | null;
  try {
    dir = await window.electronAPI.coding.chooseDirectory();
  } catch (err) {
    ElMessage.error(`目录选择失败：${(err as Error).message}`);
    return;
  }
  if (!dir) return;

  try {
    await window.electronAPI.coding.openTool(tool.id, dir);
  } catch (err) {
    console.warn('[coding] openTool failed:', (err as Error).message);
  }
}

export function onToolPickCancelled(): void {
  visible.value = false;
}

export { visible, tools };
```

> 说明：使用 module-scope 的 `ref` 是 Vue 3 单例模式，跨组件共享 dialog 状态。`initCodingDialog()` 在 App.vue setup 顶层调一次，挂订阅；HMR 清理调 `disposeCodingDialog()`。

- [ ] **Step 5: 修改 FeatureCard.vue（最小改，加 emit）**

先用 Read 工具读 `offline-app/src/components/FeatureCard.vue` 看现状。如果已有 `<button>` 或 `<div>`，保留 visual，只在 script 加 emit、template 加 `@click`。

最小改动版：

```vue
<script setup lang="ts">
import type { FeatureCard } from '@/data/assistantFeatures'

defineProps<{
  card: FeatureCard
}>()

const emit = defineEmits<{
  click: [card: FeatureCard]
}>()
</script>

<template>
  <!-- 在原 visual 根元素上加 @click="emit('click', card)" -->
  <!-- 比如原根元素是 <div class="card">，则改为：<div class="card" @click="emit('click', card)"> -->
</template>

<!-- 样式保持原状不动 -->
```

> **重要**：template 的根元素从原文复制，不要重写样式。执行 subagent 必须先读原文再做最小 diff。

- [ ] **Step 6: 修改 FeatureSection.vue（透传 click）**

```vue
<script setup lang="ts">
import type { FeatureSection, FeatureCard } from '@/data/assistantFeatures'
import FeatureCardComponent from './FeatureCard.vue'

defineProps<{ section: FeatureSection }>()
const emit = defineEmits<{ cardClick: [card: FeatureCard] }>()
</script>

<template>
  <section class="feature-section">
    <!-- 标题区保留原状 -->
    <div class="section-header">
      <div class="section-title-row">
        <h2 class="section-title">{{ section.title }}</h2>
        <span class="section-emoji">{{ section.headerIcon }}</span>
      </div>
      <p class="section-subtitle">{{ section.subtitle }}</p>
    </div>

    <!-- 卡片网格 + 透传 click -->
    <div class="card-grid">
      <FeatureCardComponent
        v-for="card in section.cards"
        :key="card.title"
        :card="card"
        @click="emit('cardClick', card)"
      />
    </div>
  </section>
</template>

<!-- 样式保持原状 -->
```

- [ ] **Step 7: 修改 App.vue（接通 onCodeClick）**

```vue
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import TopBar from '@/components/TopBar.vue';
import SideDrawer from '@/components/SideDrawer.vue';
import AppCarousel from '@/components/AppCarousel.vue';
import FeatureSection from '@/components/FeatureSection.vue';
import BottomTabBar from '@/components/BottomTabBar.vue';
import InputBar from '@/components/InputBar.vue';
import ToolPickerDialog from '@/components/ToolPickerDialog.vue';
import { aiApps, featureSections, bottomTabs } from '@/data/assistantFeatures';
import { useUiStore } from '@/stores/ui';
import {
  initCodingDialog, disposeCodingDialog,
  openCodingDialog, onToolPicked, onToolPickCancelled,
  visible, tools,
} from '@/coding-dialog';

const ui = useUiStore();

function onMenu() { ui.openDrawer(); }
function onNewChat() { console.log('new chat (offline)'); }
function onAppSelect(id: string) { ui.setActiveApp(id); }
function onTabSelect(id: string) {
  ui.setActiveTab(id);
  if (id === 'code') openCodingDialog();
}
function onCardClick(card: { title: string }) {
  if (card.title === '写代码') openCodingDialog();
  else console.log(`card click (offline): ${card.title}`);
}
function onSend(_t: string) { console.log('send (offline)'); }
function onVoiceStart() { console.log('voice start (offline)'); }
function onVoiceEnd() { console.log('voice end (offline)'); }
function onCamera() { console.log('camera (offline)'); }
function onMore() { console.log('more (offline)'); }

onMounted(() => initCodingDialog());
onUnmounted(() => disposeCodingDialog());
</script>

<template>
  <div class="app-bg desktop-shell">
    <TopBar @menu="onMenu" @new-chat="onNewChat" />
    <SideDrawer v-model="ui.drawerOpen" />

    <main class="main">
      <AppCarousel :apps="aiApps" @select="onAppSelect" />
      <div class="sections">
        <FeatureSection
          v-for="section in featureSections"
          :key="section.id"
          :section="section"
          @card-click="onCardClick"
        />
      </div>
    </main>

    <BottomTabBar :tabs="bottomTabs" @select="onTabSelect" />
    <InputBar
      @send="onSend" @voice-start="onVoiceStart" @voice-end="onVoiceEnd"
      @camera="onCamera" @more="onMore"
    />

    <!-- 工具选择 dialog（全局可见） -->
    <ToolPickerDialog
      :visible="visible"
      :tools="tools"
      @select="onToolPicked"
      @cancel="onToolPickCancelled"
    />
  </div>
</template>

<style lang="scss" scoped>
.desktop-shell {
  height: 100vh; width: 100vw;
  display: flex; flex-direction: column; overflow: hidden;
}
.main { flex: 1; overflow-y: auto; }
.sections { padding: 8px 0; }
</style>
```

- [ ] **Step 8: 编译验证**

Run: `cd offline-app && npx vue-tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 9: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
【需求/缺陷描述】: offline-app 全集成（types + toast + 自渲染 dialog + App.vue 接通）
【需求/缺陷单号】: 无
【修改内容】:
- offline-app/src/types/coding.ts（新增）: CodingTool (ExternalTool/EmbeddedTool) + CodingStatus 7 state 类型镜像
- offline-app/src/coding-toast.ts（新增）: codingToast(status) 映射 ElMessage（info/closeAll/error）
- offline-app/src/components/ToolPickerDialog.vue（新增）: 自渲染 ElDialog 列 tools；emit('select', tool) / emit('cancel')
- offline-app/src/coding-dialog.ts（新增）: module-scope ref(visible/tools) 共享状态 + initCodingDialog（挂 status 订阅 + initial status）+ openCodingDialog（listTools → 显 dialog）+ onToolPicked（chooseDirectory → openTool）+ disposeCodingDialog
- offline-app/src/components/FeatureCard.vue（最小改）: script 加 emit('click', card)；template 根元素加 @click；样式保留原状
- offline-app/src/components/FeatureSection.vue: FeatureCard @click 透传 emit('cardClick', card)
- offline-app/src/App.vue: 加 onCardClick（写代码→openCodingDialog）+ onTabSelect（code→openCodingDialog）+ onMounted(initCodingDialog)/onUnmounted(disposeCodingDialog) + template 加 <ToolPickerDialog>
EOF
git add offline-app/src/types/coding.ts \
        offline-app/src/coding-toast.ts \
        offline-app/src/coding-dialog.ts \
        offline-app/src/components/ToolPickerDialog.vue \
        offline-app/src/components/FeatureCard.vue \
        offline-app/src/components/FeatureSection.vue \
        offline-app/src/App.vue
git commit -F /tmp/commit-msg.txt
```

---

## Task 6: 手动集成验证

**Files:** 无（操作类 Task）

- [ ] **Step 1: 启 dev electron**

Run: `npm run dev`

Expected: Electron 窗口启动，显示 offline 页；点底部 `code` tab 或「写代码」卡片 → 自渲染 ElDialog 列出 7 个 tool（5 外部 + 2 内嵌）。

- [ ] **Step 2: 验证内嵌 opencode-web**

操作：选 `OpenCode Web` → 弹原生目录选择 dialog → 选个目录。

Expected:
- ElMessage「正在启动内嵌工具…」持续
- 5s 内 codingView 加载 `http://127.0.0.1:4296`
- main.log 见 `embedded ready: http://127.0.0.1:4296`

- [ ] **Step 3: 验证 dsh-web（不同端口）**

操作：选 `DeepSeek DSH` → 选目录。

Expected: codingView 加载 `http://127.0.0.1:4297`；端口 4296 被 opencode-web 占着，dsh-web 自动跳 4297。

- [ ] **Step 4: 验证 before-quit shutdown**

操作：macapp 关闭（Cmd+Q / Alt+F4）。

Expected:
- main.log 见 `app quitting` → `shutdown: killing embedded child` → `embedded exit: code=null signal=SIGTERM`
- npx 子进程被 kill，端口释放

- [ ] **Step 5: 记录验证结果**

记录哪些 step 通过 / 哪些失败，失败项 → 单独 commit 修复。

---

## 计划完成

**6 个 Task**：
- Task 1: config schema + 校验 + bundled default（30 min）
- Task 2: codingAgent 模块（30 min）
- Task 3: main.ts 集成（40 min）
- Task 4: preload.ts coding namespace（10 min）
- Task 5: offline-app 全集成（40 min）
- Task 6: 手动验证（30 min）

**总计 ~3 小时**

**精简前 vs 精简后**：
- 11 Task → 6 Task
- ~5h → ~3h
- 移除 type guards（130 行）、pickTool ElMessageBox.confirm 顺序确认（5 次确认 bug）、ui store codingStatus ref（无消费者）、FeatureCard 样式重写（视觉风险）
- 修了 external spawn 失败处理 bug
- 工具列表用用户实际工具