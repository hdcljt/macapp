# opencode 工具列表方案（v1.2 设计）

- 版本：v1.2
- 日期：2026-09-08
- 状态：待评审
- 适用：算粒AI助手（Electron 43 桌面壳，v0.7.0）
- 基线：[docs/superpowers/specs/2026-09-08-opencode-on-demand-install-and-autostart-design.md](2026-09-08-opencode-on-demand-install-and-autostart-design.md)（v1.1，已被本方案替代）
- 历史选型：[docs/opencode编程能力集成方案.md](../../opencode编程能力集成方案.md)（v1.0 草案）

---

## § 1 总体设计

### 1.1 设计动机

v1.1 spec 设计了「按需静默安装 + macapp 启动自启 opencode web」，但用户实际需求更灵活：
- 「写代码」入口不只是 opencode web，也可以是外部 AI IDE（Cursor / Windsurf / VS Code 等）
- 内嵌 web 不只是 `opencode-ai`，也可能是 `@deepseek-ai/dsh` 等
- 用户希望**每次点击选择用哪个工具**

v1.2 重新抽象为「**统一工具列表**」模型：所有可选的 AI 编码工具（外部 IDE / 内嵌 web）以同一 schema 登记到 config，dialog 列出供用户挑选。

### 1.2 与 v1.1 的关系

| 维度 | v1.1 | **v1.2** |
|---|---|---|
| 工具数量 | 1 个内嵌 opencode web | **N 个工具（任意 external / embedded 混合）** |
| 选择时机 | 无选择（默认内嵌 opencode web） | **每次点击 dialog 让用户选** |
| 启动时机 | macapp 启动 autostart 后台常驻 | **按需 spawn；不自动常驻** |
| 安装方式 | `npm i -g opencode-ai` 静默装 | **npx 自动下载/缓存（无需全局装）** |
| Node.js | 显式检测 + 缺失则 toast | **隐式（macapp 本身就是 Node 应用，假设有）** |
| 工作目录 | spawn cwd 隐式 | **每次弹 dialog 选目录** |
| 嵌入 web 数量 | 仅 opencode-ai | **任意 npx 包（如 @deepseek-ai/dsh）** |

### 1.3 核心流程

```
点击"写代码"
   ↓
dialog 列出 config.codingAgent.tools（每个显示 name + type）
   ↓ 用户选一个
弹原生目录选择 dialog（dialog.showOpenDialog）
   ↓ 用户选目录
按 tool.type 分发：
   ├── type === 'external' ─► spawn(tool.command + tool.args + dir) detached:true
   │                          主进程不跟踪；macapp 状态不变
   │
   └── type === 'embedded' ─► spawn(tool.command + tool.args + port)
                              ├─ health 轮询 http://127.0.0.1:<port> (5s)
                              ├─ 就绪 ─► codingView 加载 http://127.0.0.1:<port>
                              └─ before-quit ─► kill 进程
```

### 1.4 范围 vs 非范围

**本期做**：
- `config.codingAgent.tools` 列表 schema + 校验
- 工具列表 dialog UI（每次点"写代码"弹）
- 目录选择 dialog（每次都弹）
- `external` 类型：spawn detached，不跟踪
- `embedded` 类型：spawn + health check + codingView 加载 + before-quit 回收
- 状态机 + IPC + toast 反馈（精简版）

**本期不做**：
- 自动检测工具是否安装（v1.2 启动时跑 command 检测；本期只做 spawn 后失败报错）
- settings UI（用户编辑 config.jsonc 配置 tools）
- npx 之外的安装源（curl / 自定义命令等）
- 多 embedded web 同时跑（本期只支持一个）

### 1.5 组件图

```
┌─────────────── macapp 主进程 ────────────────┐
│                                                │
│  codingAgent.ts（v1.2 新模块，精简）           │
│  ┌──────────────────────────────────────┐    │
│  │ detectTool()      探测命令是否存在   │    │
│  │ spawnExternal()   spawn detached    │    │
│  │ spawnEmbedded()   spawn + health    │    │
│  │ pickPort()        端口探测           │    │
│  │ resolveDir()      用户选目录后解析   │    │
│  │ lifecycle         before-quit kill   │    │
│  └──────────────────────────────────────┘    │
│                                                │
│  Views: offline / content / coding（embedded 时用）│
└────────────────────────────────────────────────┘
```

### 1.6 设计原则

1. **统一抽象**：external / embedded 共用 Tool schema
2. **零安装**：用 npx 自动下载/缓存内嵌 web 包
3. **每次显式选**：不记忆上次选择；每次 dialog 选工具 + 选目录
4. **graceful degradation**：工具命令缺失 / spawn 失败 / health 超时都有 toast 反馈
5. **不自动常驻**：embedded 模式按需 spawn，不在 macapp 启动时拉起

---

## § 2 config.jsonc schema

### 2.1 Tool 类型定义

```ts
type CodingTool =
  | ExternalTool
  | EmbeddedTool;

interface BaseTool {
  /** 唯一 id，用于 dialog 区分 */
  id: string;
  /** 显示名（dialog + toast） */
  name: string;
  /** 工具描述（dialog tooltip，可选） */
  description?: string;
}

interface ExternalTool extends BaseTool {
  type: 'external';
  /** 命令（如 'cursor' / 'windsurf' / 'code'） */
  command: string;
  /** 可选：完整可执行路径（覆盖 command 的 PATH 探测） */
  path?: string;
  /** 额外参数；目录作为最后一个位置参数追加（除非 dirMode='cwd'） */
  args?: string[];
  /** 目录怎么传给命令 */
  dirMode: 'positional' | 'cwd' | 'none';
}

interface EmbeddedTool extends BaseTool {
  type: 'embedded';
  /** 命令（通常是 'npx'） */
  command: string;
  /** 命令参数；占位符 '<port>' 在 spawn 时替换为实际端口 */
  args: string[];
  /** 内嵌 web 监听端口；占用时自动探测 port+1 ~ port+4 */
  port: number;
  /** 目录怎么传给命令 */
  dirMode: 'positional' | 'cwd';
}
```

### 2.2 config.jsonc 示例

```jsonc
{
  "targetUrl": "...",
  // ... 现有 11 字段 ...
  "codingAgent": {
    "tools": [
      {
        "id": "cursor",
        "name": "Cursor",
        "description": "AI-first 代码编辑器",
        "type": "external",
        "command": "cursor",
        "args": [],
        "dirMode": "positional"
      },
      {
        "id": "windsurf",
        "name": "Windsurf",
        "type": "external",
        "command": "windsurf",
        "args": [],
        "dirMode": "positional"
      },
      {
        "id": "vscode",
        "name": "VS Code",
        "type": "external",
        "command": "code",
        "args": ["-n"],
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
        "id": "deepseek-dsh",
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
}
```

### 2.3 字段语义

| 字段 | 类型 | 必填 | 默认 | 含义 |
|---|---|---|---|---|
| `id` | string | ✓ | — | 工具唯一 id；dialog 内部用，UI 不展示 |
| `name` | string | ✓ | — | 显示名（dialog + toast） |
| `description` | string | ✗ | `""` | 可选描述 |
| `type` | `'external'` \| `'embedded'` | ✓ | — | 决定 spawn 行为 |
| `command` | string | ✓ | — | 命令字符串 |
| `path` | string | ✗ | `""` | 完整可执行路径；非空时跳过 PATH 探测 |
| `args` | string[] | ✗ | `[]` | 命令参数；`<port>` 占位符 spawn 时替换 |
| `dirMode` | `'positional'` \| `'cwd'` \| `'none'` | ✓ | — | 目录传给命令的方式（external 才支持 'none'） |
| `port` | number | ✓ for embedded | — | 监听端口；占用时自动 +1 探测（最多 5 次） |

### 2.4 校验规则

config.ts 的 validateConfig 加 codingAgent.tools 校验：

- `tools` 必须是数组，元素 ≥ 1
- 每个 tool 必须有 id（字符串非空）+ name（字符串非空）+ type（'external' | 'embedded'）
- external 必须有 command（字符串）+ dirMode（'positional' | 'cwd' | 'none'）
- embedded 必须有 command（字符串）+ args（字符串数组）+ port（1-65535）+ dirMode（'positional' | 'cwd'）
- id 必须唯一（重复 → 校验失败）
- 缺失字段 → 从 bundled default 补齐（沿用现有迁移机制）

### 2.5 向后兼容

- v1.1 spec 的 `codingAgent.{enable, binPath, installSource, port, defaultDir, autostart}` 字段在 v1.2 全部移除——如果旧 config 还有这些字段，启动时报字段错误并 process.exit(1)，提示用户参考 v1.2 schema 重新配置。

> 注：如果项目组希望保留兼容性，备选方案是 v1.2 加迁移代码把旧字段映射到 tools 列表（如 `binPath` → external tool, `port` → embedded tool）。但这增加复杂度；本期直接 break compatibility，由运维手动改 config.jsonc 即可。

---

## § 3 IPC 接口

### 3.1 preload.ts 暴露的 API

```ts
window.electronAPI.coding = {
  /** 获取 tools 列表（renderer 渲染 dialog 用） */
  listTools: (): Promise<CodingTool[]> => ipcRenderer.invoke('coding:list-tools'),

  /** 用户在 dialog 选了某个 tool + 目录 → 主进程执行 */
  openTool: (
    toolId: string,
    dir: string,
  ): Promise<{ ok: boolean; url?: string; reason?: string; message?: string }> =>
    ipcRenderer.invoke('coding:open-tool', toolId, dir),

  /** 关闭编码 view（embedded 模式专用，external 模式无意义） */
  close: (): void => ipcRenderer.send('coding:close'),

  /** 订阅 status 变化；返回 unsubscribe */
  onStatus: (cb: (status: CodingStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: CodingStatus) => cb(status);
    ipcRenderer.on('coding:status', listener);
    return () => ipcRenderer.removeListener('coding:status', listener);
  },

  /** 获取初始状态 */
  getInitialStatus: (): Promise<CodingStatus> => ipcRenderer.invoke('coding:status'),
};
```

### 3.2 main.ts 注册 handlers

```ts
ipcMain.handle('coding:list-tools', () => config.codingAgent.tools);
ipcMain.handle('coding:open-tool', async (_e, toolId: string, dir: string) => {
  const tool = config.codingAgent.tools.find((t) => t.id === toolId);
  if (!tool) return { ok: false, reason: 'unknown-tool', message: `未找到工具: ${toolId}` };
  return codingAgent.openTool(tool, dir);
});
ipcMain.handle('coding:close', () => {
  showOnly(offlineView ?? contentView);
});
ipcMain.handle('coding:status', () => codingAgent.getInitialStatus());

codingAgent.subscribe((status) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('coding:status', status);
  }
});
```

### 3.3 类型

```ts
// electron/codingAgent.ts 与 offline-app/src/types/coding.ts 同步定义
type CodingStatus =
  | { state: 'idle' }
  | { state: 'launching-external'; toolId: string }
  | { state: 'spawning-embedded'; toolId: string }
  | { state: 'ready-embedded'; url: string; toolId: string }
  | { state: 'spawn-failed'; message: string }
  | { state: 'timeout' }
  | { state: 'exited'; code: number; toolId: string };
```

---

## § 4 主进程 codingAgent 模块

### 4.1 模块接口

```ts
class CodingAgent {
  private status: CodingStatus = { state: 'idle' };
  private child: ChildProcess | null = null;
  private currentToolId: string | null = null;
  private listeners = new Set<(s: CodingStatus) => void>();

  constructor(private cfg: CodingAgentConfig) {}

  /** 用户在 dialog 选 tool + 目录 → 主进程执行 */
  async openTool(tool: CodingTool, dir: string): Promise<CodingOpenResult>;

  /** before-quit 同步阻塞 ≤2s */
  shutdown(): void;

  /** 订阅 status；返回 unsubscribe */
  subscribe(cb: (s: CodingStatus) => void): () => void;
  getStatus(): CodingStatus;
  getInitialStatus(): CodingStatus;

  private spawnExternal(tool: ExternalTool, dir: string): CodingOpenResult;
  private async spawnEmbedded(tool: EmbeddedTool, dir: string): Promise<CodingOpenResult>;
  private async healthCheck(port: number, timeoutMs: number): Promise<boolean>;
  private pickPort(preferred: number): Promise<number | null>;
  private emit(next: CodingStatus): void;
}

type CodingOpenResult =
  | { ok: true; url?: string }
  | { ok: false; reason: 'unknown-tool' | 'spawn-failed' | 'timeout'; message: string };
// 注：renderer 层 dialog 取消（tool 选择 / 目录选择）不通过 IPC 返回，
// 主进程 openTool 只会拿到「用户已确认要执行」的调用。
```

### 4.2 openTool 决策树

```
codingAgent.openTool(tool, dir)
   ├── tool.type === 'external'
   │     ├── spawn(tool.command, [...args, ...positional], { detached: true, stdio: 'ignore' })
   │     │    成功 ─► emit({ state: 'launching-external', toolId }) ─► return { ok: true }
   │     │    失败 ─► emit({ state: 'spawn-failed', message }) ─► return { ok: false }
   │     └── dirMode='cwd' → spawn 选项 cwd=dir；'positional' → args 追加 dir；'none' → 不传
   │
   └── tool.type === 'embedded'
         ├── pickPort(tool.port) 失败（5 个全占） ─► return { ok: false, reason: 'spawn-failed' }
         ├── spawn(tool.command, [...args with <port> replaced], { cwd: dir, stdio: 'pipe' })
         ├── emit({ state: 'spawning-embedded', toolId })
         ├── healthCheck(port, 5000)
         │     ├── ready ─► emit({ state: 'ready-embedded', url, toolId })
         │     │           showCodingView(url)  // 主进程切 view
         │     │           return { ok: true, url }
         │     └── timeout ─► kill 进程 ─► emit({ state: 'timeout' })
         │                    return { ok: false, reason: 'timeout' }
```

### 4.3 spawn 参数

**External**:
```ts
spawn(
  tool.path || tool.command,
  buildArgs(tool.args, dir, tool.dirMode),
  {
    detached: true,        // macapp 退出不影响 IDE
    stdio: 'ignore',       // 不接日志
    cwd: tool.dirMode === 'cwd' ? dir : process.cwd(),
  }
).unref();  // macapp 不等待 IDE 退出
```

**Embedded**:
```ts
spawn(
  tool.command,
  buildArgs(tool.args, dir, tool.dirMode, port),
  {
    cwd: tool.dirMode === 'cwd' ? dir : process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],  // stdout/stderr 接 logger
    detached: false,       // macapp 退出时 kill
  }
);
```

### 4.4 args 构造

```ts
function buildArgs(
  template: string[],
  dir: string,
  dirMode: DirMode,
  port?: number,
): string[] {
  const result = template.map((arg) =>
    arg === '<port>' ? String(port) : arg
  );
  if (dirMode === 'positional') result.push(dir);
  return result;
}
```

### 4.5 端口探测

```ts
private async pickPort(preferred: number): Promise<number | null> {
  for (let p = preferred; p < preferred + 5; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}
```

### 4.6 health 检查

```ts
private async healthCheck(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return true;
    } catch { /* 连接拒绝，继续轮询 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
```

### 4.7 进程退出监听

```ts
child.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) {
    emit({ state: 'exited', code: code ?? -1, toolId: this.currentToolId ?? '' });
  }
});
```

仅对 embedded 类型生效（external 是 detached，不跟踪）。

### 4.8 shutdown

```ts
shutdown(): void {
  if (!this.child || this.child.killed) return;
  this.child.kill('SIGTERM');
  const start = Date.now();
  // 同步阻塞最多 2s
  while (this.child && !this.child.killed && Date.now() - start < 2000) {
    /* spin */
  }
  if (this.child && !this.child.killed) {
    this.child.kill('SIGKILL');
  }
}
```

仅 embedded 模式有 child 进程；external 模式 this.child 始终为 null。

---

## § 5 main.ts 集成

### 5.1 启动时序

```ts
app.whenReady().then(async () => {
  initLogger();
  registerLogHandlers();
  const config = await loadConfig();
  registerIpcHandlers(config.useOfflineFallback ? 'offline-first' : 'legacy');
  createMainWindow(config);

  // v1.2: 创建 codingAgent 单例（无 autostart）
  codingAgent = new CodingAgent(config.codingAgent);

  // 状态变更推送
  codingAgent.subscribe((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('coding:status', status);
    }
  });

  setImmediate(() => { /* updater init */ });
  app.on('activate', () => { /* existing */ });
});

app.on('before-quit', () => {
  log.info('app quitting');
  codingAgent?.shutdown();  // v1.2: 仅 embedded 模式有意义
  closeLogger();
});
```

### 5.2 codingView 创建（同 v1.1）

```ts
function createCodingView(url: string): WebContentsView { /* 同 v1.1 §4.5 */ }

function showCodingView(url: string): void {
  if (!codingView) codingView = createCodingView(url);
  else codingView.webContents.loadURL(url);
  showOnly(codingView);
}
```

### 5.3 IPC handlers（在 registerIpcHandlers 末尾追加）

见 §3.2。

---

## § 6 offline-app 集成

### 6.1 文件改动

| 文件 | 改动 |
|---|---|
| `offline-app/src/types/coding.ts` | 新增（精简 CodingStatus + CodingTool 类型副本） |
| `offline-app/src/coding-toast.ts` | 新增（toast 反馈） |
| `offline-app/src/coding-dialog.ts` | 新增（工具选择 + 目录选择 dialog 编排） |
| `offline-app/src/stores/ui.ts` | 加 codingStatus ref + onStatus 订阅 |
| `offline-app/src/data/assistantFeatures.ts` | 「写代码」卡加 action: 'coding' |
| `offline-app/src/App.vue` | 加 onCodeClick + openCodingDialog |

### 6.2 coding-dialog.ts 设计

```ts
import { ElDialog, ElMessage } from 'element-plus';
import type { CodingTool } from '@/types/coding';

/**
 * 弹出工具选择 dialog，返回用户选的 tool + 目录；取消返回 null。
 * 流程：
 *   1) 调 electronAPI.coding.listTools() 拿 tools 列表
 *   2) 显示 ElDialog 列出所有 tool（每个一个按钮）
 *   3) 用户点 tool → 调 dialog.showOpenDialog 选目录
 *   4) 调 electronAPI.coding.openTool(toolId, dir) 执行
 */
export async function openCodingDialog(): Promise<void> {
  const tools = await window.electronAPI.coding.listTools();
  if (tools.length === 0) {
    ElMessage.warning('未配置任何编码工具，请编辑 config.jsonc');
    return;
  }

  // 显示选择 dialog（自定义 ElDialog 渲染 tools 列表）
  // 每个 tool 一个按钮，点击后 resolve(tool)
  const tool = await new Promise<CodingTool | null>((resolve) => {
    showToolPickerDialog(tools, resolve);
  });
  if (!tool) return; // 取消

  // 主进程弹原生目录选择 dialog
  const dir = await window.electronAPI.coding.chooseDirectory();
  if (!dir) return; // 取消

  // 执行
  const result = await window.electronAPI.coding.openTool(tool.id, dir);
  if (!result.ok) {
    console.warn('[coding] open failed:', result.reason, result.message);
    // 错误已由 toast 反馈
  }
}
```

### 6.3 chooseDirectory IPC（新增）

```ts
// preload.ts
chooseDirectory: (): Promise<string | null> =>
  ipcRenderer.invoke('coding:choose-directory'),

// main.ts
ipcMain.handle('coding:choose-directory', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '选择项目目录',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
```

### 6.4 coding-toast.ts

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
      ElMessage.error(`启动失败：${status.message}`);
      break;
    case 'timeout':
      ElMessage.error('工具启动超时（5s 未就绪）');
      break;
    case 'exited':
      ElMessage.error(`工具已退出（code=${status.code}）`);
      break;
    case 'idle':
      break;
  }
}
```

### 6.5 ui store

```ts
const codingStatus = ref<CodingStatus>({ state: 'idle' });

if (window.electronAPI) {
  window.electronAPI.coding.getInitialStatus().then((s) => {
    codingStatus.value = s;
  });
  const unsub = window.electronAPI.coding.onStatus((s) => {
    codingStatus.value = s;
    codingToast(s);
  });
  if (import.meta.hot) {
    import.meta.hot.dispose(() => unsub());
  }
}
```

### 6.6 App.vue

```ts
import { openCodingDialog } from '@/coding-dialog';

function onCodeClick() {
  if (window.electronAPI) {
    openCodingDialog();
  } else {
    console.log('coding click (dev mode, no IPC)');
  }
}
```

FeatureCard「写代码」和 BottomTabBar「code」tab 都走 `onCodeClick`。

### 6.7 dev 模式兼容

dev 模式（仅 Vite，无 IPC）下：
- `window.electronAPI` undefined
- onCodeClick 仅 console.log

```ts
function onCodeClick() {
  if (window.electronAPI) {
    openCodingDialog();
  } else {
    console.log('coding click (dev mode, no IPC)');
  }
}
```

---

## § 7 状态机

### 7.1 状态转换图

```
              openTool(external)
              ────────────────────►  launching-external
                                          │
                                          ├─ spawn 成功 ─► idle（macapp 不跟踪）
                                          └─ spawn 失败 ─► spawn-failed

              openTool(embedded)
              ─────────────────────►  spawning-embedded
                                          │
                                          ├─ health 5s 就绪 ─► ready-embedded ─► exited (code≠0)
                                          │                       │
                                          │                       └─ close() ─► idle (kill child)
                                          │
                                          └─ health 超时 ─► timeout ─► idle (kill child)
```

### 7.2 状态语义

| state | 含义 | UI 表现 |
|---|---|---|
| `idle` | 无活动；初始 + 完成后默认 | 无提示 |
| `launching-external` | 正在 spawn external tool | ElMessage「正在启动外部 IDE…」短暂 toast |
| `spawning-embedded` | 正在 spawn embedded tool | ElMessage「正在启动内嵌工具…」持续 |
| `ready-embedded` | embedded tool 就绪 | codingView 加载；ElMessage.closeAll |
| `spawn-failed` | spawn 失败 | ElMessage.error |
| `timeout` | health 超时 | ElMessage.error |
| `exited` | 运行中进程异常退出 | ElMessage.error；dialog 可再次打开 |

### 7.3 与 v1.1 状态对比

| v1.1 | v1.2 | 说明 |
|---|---|---|
| unavailable | （无） | 不再有"工具不存在"状态——dialog 让用户选，没装就 spawn 失败 |
| installing | （无） | 不再安装——npx 自动下载 |
| spawning | spawning-embedded | 改名加 type 后缀 |
| ready | ready-embedded | 改名 |
| exited | exited | 一致 |
| spawn-failed | spawn-failed | 一致 |
| timeout | timeout | 一致 |

---

## § 8 生命周期与错误处理

### 8.1 错误矩阵

| 失败点 | UI 反馈 | 用户操作 |
|---|---|---|
| tools 列表为空 | ElMessage.warning「未配置任何编码工具」 | 改 config.jsonc |
| 用户在 tool dialog 点取消 | 无操作 | 重试 |
| 用户在目录 dialog 点取消 | 无操作 | 重试 |
| tool.command 不在 PATH | spawn 失败 → ElMessage.error + log error | 改 config 或装工具 |
| external 启动后立即退出 | detached 不跟踪；toast 不一定看得到 | 检查 PATH / 重试 |
| embedded spawn 失败 | ElMessage.error | 改 tool.args / 重试 |
| embedded health 5s 超时 | 自动 kill + ElMessage.error | 重试 |
| 端口 4296-4300 全被占 | spawn-failed + log error | 改 tool.port |
| embedded 运行中异常退出 | ElMessage.error「工具已退出」 | 再点"写代码" |
| npx 首次下载失败（网络） | spawn 失败 → log error（stderr） | 检查网络 / 重试 |
| 主进程弹目录 dialog 时窗口未聚焦 | 走 BrowserWindow.getFocusedWindow() fallback | — |

### 8.2 安全基线

| 项 | 措施 |
|---|---|
| external spawn | detached:true + stdio:'ignore' + .unref() —— 不暴露 stdin/stdout 给外部进程 |
| embedded spawn | cwd 限定为用户选的目录（不传任意 path） |
| embedded 网络 | --hostname 127.0.0.1 强制回环 |
| codingView 导航 | 仅允许 http://127.0.0.1:<port>/*（白名单） |
| 外链 | https: 走 shell.openExternal |
| sandbox | codingView sandbox:false（本地可信端口），contextIsolation+nodeIntegration 同 v1.1 |
| 工具命令 | 用户自配；本期不做 command 白名单（信任 config 来源） |

### 8.3 边界 case

| Case | 处理 |
|---|---|
| 用户连点多次"写代码" | dialog 替换（Element Plus 默认行为）；若已开 codingView，第二次 click 切到 codingView 不再 dialog |
| embedded tool 还在跑时再次 dialog 选同一个 | 走 spawn 失败（端口被占）→ toast |
| embedded tool 还在跑时 dialog 选不同 embedded | 走 spawn 失败（端口被占）→ toast，提示先关闭 |
| macOS TCC：目录不可访问 | spawn 失败 → log error + toast |
| Windows 长路径 | spawn 不需要特别处理（cwd 已是绝对路径） |
| 用户在 dialog 选了目录但 tool command 缺失 | spawn 失败 → toast + log |

---

## § 9 与 v1.1 spec 的兼容性

### 9.1 v1.1 字段移除

v1.2 不再支持以下 v1.1 config 字段：
- `codingAgent.enable` → 用 tools 列表非空判断
- `codingAgent.binPath` → 用 external tool.path
- `codingAgent.installSource` → 不再需要安装
- `codingAgent.port` → 每个 embedded tool 自己有 port
- `codingAgent.defaultDir` → 每次 dialog 选目录
- `codingAgent.autostart` → 不再后台常驻

### 9.2 迁移策略

v1.1 → v1.2 config 迁移**不做自动迁移**。理由：
- v1.1 还没发布到生产
- schema 差异大，自动迁移容易出错
- 运维/用户改一次 config.jsonc 即可

迁移文档（在 v1.2 plan 中提供）：
```jsonc
// v1.1
{
  "codingAgent": {
    "enable": true,
    "binPath": "",
    "installSource": "",
    "port": 4296,
    "defaultDir": "",
    "autostart": true
  }
}

// v1.2
{
  "codingAgent": {
    "tools": [
      { "id": "opencode-web", "name": "OpenCode Web", "type": "embedded", "command": "npx", "args": ["opencode-ai", "web", "--port", "<port>", "--hostname", "127.0.0.1"], "port": 4296, "dirMode": "cwd" }
    ]
  }
}
```

### 9.3 v1.1 spec 标注

v1.1 spec 文件加一行「已被 v1.2 替代」（spec 文件末尾注明）；保留作为设计选型记录。

---

## § 10 实施里程碑

### M1 原型验证（0.5 ~ 1 天）

- 手写一份 config.jsonc 包含 cursor + opencode-web 两个 tool
- 实现 codingAgent.openTool 最小版本（external + embedded 各 1 个分支）
- 跑 npm run dev → 点"写代码" → dialog → 选 tool → 选目录 → 验证

### M2 完整功能（2 ~ 3 天）

| 子任务 | 估时 |
|---|---|
| config.ts schema + 校验（含 tools 数组） | 0.5d |
| codingAgent 模块精简实现（detect 砍掉，只剩 spawn + health + lifecycle） | 1d |
| main.ts 集成（IPC + codingView + chooseDirectory） | 0.5d |
| preload.ts coding namespace | 0.5d |
| offline-app coding-dialog + coding-toast + ui store | 0.5d |
| App.vue onCodeClick 接通 | 0.5d |
| 单元测试（codingAgent.test.ts） | 0.5d |

### M3 增强（可选）

- 自动检测 tool 是否安装（which/where 探测，未装的在 dialog 灰显）
- 工具结果回传（spawn 退出码 → toast 显示）
- npx registry 镜像配置（内网环境）
- settings UI（用户可视化编辑 tools 列表）

---

## § 11 风险与对策

| 风险 | 影响 | 概率 | 对策 |
|---|---|---|---|
| npx opencode-ai web 命令格式与实际包不一致 | spawn 失败 | 中 | M1 原型验证；不通过则改 tool.args 模板 |
| npx @deepseek-ai/dsh web 同上 | spawn 失败 | 中 | 同上 |
| npx 首次下载慢（几十秒） | 用户体验差 | 中 | spawn 后 status='spawning-embedded' + ElMessage「正在下载…」提示 |
| 两个 embedded tool 同时跑（端口冲突） | 后跑的 spawn 失败 | 低 | 暂不解决；本期不支持多 embedded 同跑 |
| 工具 command 在某些 PATH 下找不到 | spawn 失败 | 中 | 提示用户用 path 字段填绝对路径；M3 加 auto-detect |
| external spawn 后立即失败（如 cursor 缺依赖） | 用户看不到反馈 | 中 | external 也可监听 stderr（M3） |
| macOS Gatekeeper 拦截外部 IDE | 启动失败 | 中 | 文档提示用户首次运行手动授权 |

---

## § 12 验收标准（M2 完成时）

- [ ] config.jsonc 配置 2 个 external + 2 个 embedded tool，启动不报错
- [ ] 点"写代码" → 弹出工具选择 dialog（4 个 tool）
- [ ] 选 Cursor → 弹目录 dialog → 选目录 → Cursor 打开该目录
- [ ] 选 OpenCode Web → 弹目录 dialog → 选目录 → codingView 加载 opencode web UI
- [ ] 选 DeepSeek DSH → 弹目录 dialog → 选目录 → codingView 加载 dsh web UI
- [ ] 在 dialog 点取消 → 无操作
- [ ] 在目录 dialog 点取消 → 无操作
- [ ] embedded 模式下点关闭 → 切回 offlineView，opencode 进程 kill
- [ ] macapp 退出 → 日志见 embedded child kill，external 不影响
- [ ] 端口 4296 被占 → 自动跳 4297，toast 正常
- [ ] 工具 command 不存在 → spawn 失败 toast + log error
