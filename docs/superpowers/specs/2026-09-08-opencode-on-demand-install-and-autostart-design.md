# opencode 按需安装 + macapp 启动自启方案（v1.1 增量设计）

- 版本：v1.1（在 v1.0 草案基础上增量设计）
- 日期：2026-09-08
- 状态：待评审
- 适用：算粒AI助手（Electron 43 桌面壳，v0.7.0）
- 基线：[docs/opencode编程能力集成方案.md](docs/opencode编程能力集成方案.md)（v1.0 草案）

---

## § 1 总体设计

### 1.1 与 v1.0 草案的关系

| 维度 | v1.0 草案 | **v1.1（本次）** |
|---|---|---|
| 安装触发 | 首次点"写代码" tab | **首次点"写代码" tab（不变）** |
| 安装 UI | 引导 wizard（进度 + 日志） | **静默安装 + 结果 toast** |
| 默认安装源 | `https://opencode.ai/install`（curl） | **`npm i -g opencode-ai`** |
| macapp 启动 | 不启动 opencode | **启动时若 opencode 可用，自动 spawn `opencode web` 后台常驻** |
| Node.js | 未涉及 | **首次点"写代码"时检测；缺失则 toast 引导用户装** |
| 安装器改造 | 无 | **完全不动**（不需改 .dmg / .pkg / NSIS） |

### 1.2 核心流程

```
用户安装 macapp（啥都不做，标准安装流程）
   ↓
macapp 启动
   ↓ detect opencode
   ├── 已装且可用 ──► spawn `opencode web`（后台常驻，编码 tab 随时秒开）
   └── 未装 / 检测失败 ──► 跳过 spawn，记日志（编码 tab 仍可点）
用户点 "写代码" tab
   ↓ codingAgent.open()
   ├── opencode 已在跑 ──► showOnly(codingView) 秒切
   ├── 已装但没跑 ──► spawn，轮询 health 就绪后切
   └── 未装 ──► 检测 Node.js / npm
                  ├── 通过 ──► 静默 `npm i -g opencode-ai`
                  │            ├── 成功 ──► spawn `opencode web`，就绪后切
                  │            └── 失败 ──► toast「安装失败，<原因>」+ 重试 / 取消
                  └── 缺失 ──► toast「请先安装 Node.js（含 npm）→ nodejs.org」
```

### 1.3 范围 vs 非范围

**本期做**：
- macapp 启动时 detect + 自动 spawn `opencode web`（常驻至 `before-quit`）
- 编码 tab 点击时按需安装（npm）+ spawn + 切 view
- 默认安装源 `npm i -g opencode-ai`，可通过 `config.jsonc.codingAgent.installSource` 覆盖
- Node.js / npm 缺失时给 toast + 引导文案
- 安装进度/失败反馈用 Element Plus `ElMessage` / `ElNotification`（沿用 offline-app 现有依赖）

**本期不做**：
- 不改安装器（.dmg / NSIS / .pkg 都不动）
- 不捆绑 Node.js
- 不做 first-use 安装 wizard UI
- 不做 opencode 自更新
- 不做 TUI 嵌入

### 1.4 组件图

```
┌─────────────── macapp 主进程 ────────────────┐
│                                                │
│  codingAgent.ts（v1.1 新增）                  │
│  ┌──────────────────────────────────────┐    │
│  │ detect()       which/where + --version│    │
│  │ install(opts)  静默 npm i -g         │    │
│  │ spawn(opts)    opencode web          │    │
│  │ health()       GET / 轮询            │    │
│  │ lifecycle      autostart + before-quit│    │
│  └──────────────────────────────────────┘    │
│                                                │
│  Views: offline / content / coding（沿用 v1.0）│
└────────────────────────────────────────────────┘
                       │
                       │ spawn (cwd=项目目录 or ~)
                       ▼
              ┌──────────────────┐
              │  opencode web    │  ← macapp 启动时拉起
              │  127.0.0.1:4296  │  ← codingView WebContentsView 加载
              └──────────────────┘
```

### 1.5 设计原则

1. **零安装器改造**：所有逻辑都在主进程，不动 .dmg / NSIS / .pkg
2. **静默优于弹窗**：安装过程无 wizard，结果用 toast 反馈
3. **graceful degradation**：缺 Node、npm 失败、opencode 崩溃都不影响 macapp 主体
4. **保留 v1.0 架构**：codingView、IPC 接口、导航白名单全部沿用，只改触发点和默认源

---

## § 2 macapp 启动自启 opencode web + 进程生命周期

### 2.1 启动期 spawn 决策树

```
app.whenReady()
  → loadConfig() / registerIpcHandlers() / createMainWindow()   （沿用现有）
  → setImmediate(codingAgent.tryAutostart())
       ↓
   detect()  // 同步可达：which/where opencode + --version
       ├── 不可用 ──► log.info("opencode not available, skipping autostart")
       │              codingAgent.status = 'unavailable'
       │              （编码 tab 仍可点；点击时再走 install 路径）
       │
       └── 可用 ──► spawn 'opencode web' 端口 4296 hostname 127.0.0.1
                      ├── spawn 失败 ──► log.error，记 status='spawn-failed'
                      └── spawn 成功 ──► health 轮询（GET / 2xx）
                                        ├── 5s 内就绪 ──► status='ready'
                                        └── 超时 ──► status='timeout'，kill 进程
```

### 2.2 配置开关

新增 `config.jsonc.codingAgent.autostart`（默认 `true`）：
- `true`：macapp 启动时若 opencode 可用就 spawn
- `false`：永不自动 spawn，编码 tab 点击时才走 install + spawn 路径

运维/用户想要「装 macapp 但不用 opencode」→ 在 config.jsonc 改 `autostart: false`。

### 2.3 进程生命周期

| 触发事件 | 行为 |
|---|---|
| macapp 启动 + autostart=true + opencode 可用 | spawn `opencode web`（后台） |
| `opencode web` 就绪 | status='ready'，可被 codingView 加载 |
| 用户点编码 tab | `showOnly(codingView)` 加载 `http://127.0.0.1:<port>` |
| 用户点其他 tab / 关闭编码 view | **不杀进程**，保留会话（下次切回秒开） |
| 主窗口关闭（macOS activate 时） | 不杀进程 |
| `app.before-quit` | kill opencode 进程，等 exit 或 2s timeout |
| `app.window-all-closed`（非 darwin） | 先 kill 再 quit |
| opencode 进程异常退出 | 推送 `coding:status`，UI toast「opencode 已退出」，编码 tab 变灰 |
| 端口 4296 被占用 | 自动探测 4297-4300，找空闲的；都占则失败 + toast |

### 2.4 spawn 参数

```ts
spawn(binPath, [
  'web',
  '--port', String(port),       // 4296 或探测到的空闲端口
  '--hostname', '127.0.0.1',    // 仅回环，不暴露局域网
  '--cwd', projectDir,          // 默认 ~/Documents 或用户配置
], {
  cwd: projectDir,
  env: { ...process.env, OPENCODE_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],  // stdout/stderr 接 logger
  detached: false,               // macapp 退出时一并回收
})
```

### 2.5 health 检查

- 轮询 `http://127.0.0.1:<port>/`，每 200ms 一次，最多 5s（25 次）
- 2xx 响应即视为就绪
- 5s 未就绪 → kill 进程，status='timeout'，编码 tab 点击时重试

### 2.6 opencode 进程异常退出处理

- `child.on('exit', (code, signal) => ...)`：code ≠ 0 时推 IPC `coding:status` 事件 `{ state: 'exited', code, signal }`
- UI 收到 → ElMessage.error(`opencode 异常退出 (code=${code})`) + 编码 tab 变灰 + tooltip「服务已退出，点击重试」
- 不自动重启（避免崩溃循环），等用户主动点击重试

---

## § 3 编码 tab 点击路径（按需安装 + spawn）

### 3.1 决策树

```
用户点 "写代码" tab
   ↓ preload.coding.open()
主进程 codingAgent.handleOpen()
   ├── status === 'ready'              ──► IPC 回 {ok:true, url}；主进程内部自动 showOnly(codingView)
   ├── status === 'spawning'           ──► 等 health 就绪后回 {ok:true, url}；主进程自动 showOnly
   ├── status === 'unavailable'        ──► 走 install 路径（§3.2）
   ├── status === 'installing'         ──► 回前端 status，前端 toast「正在安装…」
   ├── status === 'spawn-failed'       ──► 走 install 路径（重试）
   └── status === 'timeout'            ──► 走 install 路径（重试 spawn）
```

**view 切换归属**：view 管理完全在主进程（`showOnly` 是 [electron/main.ts:30](electron/main.ts#L30) 主进程函数，前端无法直接调用）。`coding:open` 成功时由主进程内部自动调用 `showOnly(codingView)`；前端不需做任何 view 操作，只需要听 `coding:status` 推送做 toast / tab 视觉反馈即可。open() 返回的 `url` 仅供前端日志或调试用。

### 3.2 install 路径

```ts
async function installAndStart() {
  // ① Node.js / npm 检测
  const nodeCheck = await detectNode();
  if (!nodeCheck.ok) {
    return { ok: false, reason: 'no-node', message: '请先安装 Node.js（含 npm）→ nodejs.org' };
  }

  // ② 静默安装
  pushStatus({ state: 'installing', source: installSource });
  const installResult = await runNpmInstall(installSource);
  if (!installResult.ok) {
    return { ok: false, reason: 'install-failed', message: installResult.stderr };
  }

  // ③ 重新 detect + spawn
  const detect = await detectOpencode();
  if (!detect.installed) {
    return { ok: false, reason: 'still-missing', message: '安装后仍检测不到 opencode' };
  }

  const spawnResult = await spawnOpencode(detect.binPath);
  if (!spawnResult.ok) {
    return { ok: false, reason: 'spawn-failed', message: spawnResult.message };
  }

  return { ok: true, url: spawnResult.url };
}
```

### 3.3 UI 反馈（前端）

| 状态 | UI 表现 |
|---|---|
| `installing` | ElMessage.info(`正在安装 opencode…`) 持续显示 |
| `install-failed` | ElMessage.error(`安装失败：${message}`) + 「重试」按钮 |
| `no-node` | ElNotification（更显眼，带操作链接）`请先安装 Node.js` + 「打开 nodejs.org」按钮（调 shell.openExternal） |
| `spawn-failed` | ElMessage.error(`启动失败：${message}`) + 「重试」 |
| `ok` | showOnly(codingView)，toast 关闭 |

**禁用交互**：installing 状态下编码 tab 二次点击忽略（避免重复触发）；UI 显示 loading spinner。

### 3.4 Node.js 检测

```ts
async function detectNode(): Promise<{ ok: boolean; nodeVersion?: string; npmVersion?: string }> {
  // 用 spawnSync 而非 spawn，避免异步 + 简单阻塞调用
  const node = spawnSync('node', ['--version'], { encoding: 'utf-8' });
  if (node.status !== 0) return { ok: false };
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf-8' });
  if (npm.status !== 0) return { ok: false };
  return {
    ok: true,
    nodeVersion: node.stdout.trim(),
    npmVersion: npm.stdout.trim(),
  };
}
```

**最低版本要求**：参考 opencode-ai npm 包要求，建议 `node >= 18.0.0`。低于则 toast 提示升级（不阻断，看用户选择）。

### 3.5 npm install 命令构造

默认：`['npm', 'install', '-g', 'opencode-ai']`

可配置（`config.jsonc.codingAgent.installSource`）：
- 空字符串（默认）：走默认 `npm install -g opencode-ai`
- `npm:opencode-ai@latest`：拼成 `npm install -g opencode-ai@latest`
- `npm:<registry-url>`：拼成 `npm install -g opencode-ai --registry=<url>`
- `command:<自定义命令>`：直接执行用户提供的命令（高级用户）

**实现简化**：本期只支持 `npm install -g opencode-ai`，installSource 仅作预留字段（本期不解析，等真实需求时再扩展）。

### 3.6 编码 tab 的视觉态

| opencode 状态 | tab 显示 |
|---|---|
| 未点击过 + 未装 | 正常显示，点击走 install 路径 |
| 已装 + 服务 ready | 正常显示，点击秒切 |
| 正在安装 | spinner + 「正在安装…」文字（短暂） |
| 异常退出 | 灰显 + 角标红点，hover 提示「服务已退出」 |

---

## § 4 config.jsonc 扩展 + IPC 接口 + 导航白名单

### 4.1 config.jsonc 新增字段

新增嵌套对象 `codingAgent`（沿用 v1.0 草案命名，**保留向后兼容**——v1.0 草案的 5 个字段全部保留，本期只调整默认值）：

```jsonc
{
  "targetUrl": "...",
  // ... 现有 11 字段 ...
  "codingAgent": {
    "enable": true,                 // v1.0：总开关
    "binPath": "",                  // v1.0：自定义 opencode 路径
    "installSource": "",            // v1.0：自定义安装源（本期预留）
    "port": 4296,                   // v1.0：固定端口
    "defaultDir": "",               // v1.0：默认工作目录
    "autostart": true               // v1.1 新增：macapp 启动时是否自动 spawn opencode web
  }
}
```

**字段语义**：

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enable` | boolean | `true` | 总开关；`false` 时编码 tab 隐藏 |
| `binPath` | string | `""` | 自定义 opencode 可执行路径；空 = `which opencode` / `where opencode` 探测 |
| `installSource` | string | `""` | 自定义安装源；本期保留字段不解析（默认走 `npm i -g opencode-ai`） |
| `port` | number | `4296` | opencode web 监听端口；占用时自动探测 4297-4300 |
| `defaultDir` | string | `""` | opencode web 的 cwd；空 = 用平台默认（macOS: `~/Documents`，Win: `%USERPROFILE%`） |
| `autostart` | boolean | `true` | macapp 启动时若 opencode 可用，自动 spawn `opencode web` |

### 4.2 config.ts 改动点

`AppConfig` 接口新增字段 → `validateConfig` 新增校验 → 现有「缺失字段从 bundled 补齐」机制自动覆盖（无需新写迁移代码）。

校验规则：
- `enable` / `autostart` 必须 boolean
- `binPath` / `installSource` / `defaultDir` 字符串（可空）
- `port` 1-65535 整数
- 整体结构 `codingAgent` 可选（缺失时整个对象用默认值）

### 4.3 IPC 接口（preload.ts 扩展）

沿用 v1.0 草案命名空间 `window.electronAPI.coding.*`：

```ts
coding: {
  // 用户点编码 tab → 主进程按需安装+spawn，返回 url
  open: () => Promise<{ ok: boolean; url?: string; reason?: string; message?: string }>,
  // 关闭编码 view（不杀进程，只切 view；保留会话）
  close: () => void,
  // 订阅 coding:status 推送
  onStatus: (cb: (status: CodingStatus) => void) => () => void,
  // 重试 install / spawn
  retry: () => Promise<{ ok: boolean; url?: string; message?: string }>,
}

type CodingStatus =
  | { state: 'unavailable' }
  | { state: 'spawning' }
  | { state: 'ready'; url: string }
  | { state: 'installing' }
  | { state: 'exited'; code: number; signal?: string }
  | { state: 'spawn-failed'; message: string }
  | { state: 'timeout' };
```

**与 v1.0 差异**：
- `open` / `close` 不变
- `install` / `chooseDir` / `status`（v1.0 草案）**本期不暴露**：
  - `install` 由 `open` 自动触发，外部不需显式调
  - `chooseDir` 暂不需要（用 `defaultDir`）
  - `status` 用 `onStatus` 订阅替代
- 新增 `retry`：异常退出后用户点重试

### 4.4 main.ts 注册 IPC

在 `registerIpcHandlers(mode)` 末尾追加 `coding:*` 一组（沿用「启动时一次性注册」模式）：

```ts
ipcMain.handle('coding:open', () => codingAgent.handleOpen());
ipcMain.handle('coding:close', () => codingAgent.handleClose());
ipcMain.handle('coding:retry', () => codingAgent.handleRetry());
// coding:status 用 webContents.send 推送
```

### 4.5 导航白名单（codingView 独立）

沿用 v1.0 草案 §4.6：

```ts
function attachCodingViewHandlers(view: WebContentsView, allowedOrigin: string) {
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault();
      log.warn(`codingView will-navigate blocked: ${url}`);
    }
  });
}
```

`allowedOrigin = 'http://127.0.0.1:<port>'`（spawn 时探测到的实际端口）。

**与 contentView 隔离**：codingView 独立 webPreferences + 独立白名单，不污染在线页面。

### 4.6 沙箱配置

- codingView `sandbox: false`（本地 127.0.0.1 服务，本会话端口，可信）
- 与 `createUrlView` 配置一致（沿用现有 [electron/main.ts:89-104](electron/main.ts#L89-L104)）

---

## § 5 与现有主进程的整合 + 错误处理 + 日志

### 5.1 主进程初始化时序（改动后）

```ts
app.whenReady().then(async () => {
  initLogger();
  registerLogHandlers();
  const config = await loadConfig();
  registerIpcHandlers(config.useOfflineFallback ? 'offline-first' : 'legacy');
  createMainWindow(config);

  setImmediate(() => {
    try {
      initUpdater({ ... });
      checkForUpdates();
    } catch (err) { ... }
  });

  // v1.1 新增：启动期 spawn opencode web（autostart=true 时）
  setImmediate(() => {
    if (config.codingAgent.enable && config.codingAgent.autostart) {
      codingAgent.tryAutostart(config.codingAgent).catch((err) => {
        log.error(`codingAgent autostart failed: ${(err as Error).message}`);
      });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(config);
    }
  });
});
```

**关键点**：
- `setImmediate` 包裹：spawn 失败不能影响主流程（对齐 updater 模式）
- `config.codingAgent.enable === false` 时完全不初始化 codingAgent（编码 tab 隐藏）
- macOS activate 重开窗口不触发 autostart（避免重复 spawn）

### 5.2 退出回收（before-quit）

```ts
app.on('before-quit', () => {
  log.info('app quitting');
  closeLogger();
  codingAgent.shutdown();  // v1.1 新增：kill opencode 进程
});
```

`codingAgent.shutdown()`：
- 如果 opencode 进程在跑 → `kill('SIGTERM')` → 等 2s → 未退则 `kill('SIGKILL')`
- 如果没在跑 → noop
- 同步阻塞 2s（before-quit 阶段允许短阻塞）

### 5.3 codingAgent 模块接口

新增文件 `electron/codingAgent.ts`：

```ts
class CodingAgent {
  private status: CodingStatus = { state: 'unavailable' };
  private child: ChildProcess | null = null;
  private port: number;
  private listeners = new Set<(s: CodingStatus) => void>();

  async tryAutostart(cfg: CodingAgentConfig): Promise<void>;
  async handleOpen(): Promise<{ ok: boolean; url?: string; reason?: string; message?: string }>;
  async handleClose(): Promise<void>;
  async handleRetry(): Promise<{ ok: boolean; url?: string; message?: string }>;
  shutdown(): void;  // 同步阻塞 ≤2s
  getStatus(): CodingStatus;
  getUrl(): string | null;  // ready 时返回 url，给 codingView 加载

  private async detect(): Promise<{ installed: boolean; binPath?: string }>;
  private async spawn(): Promise<{ ok: boolean; url?: string; message?: string }>;
  private async install(): Promise<{ ok: boolean; message?: string }>;
  private async healthCheck(timeoutMs: number): Promise<boolean>;
  private emit(s: CodingStatus): void;
}
```

### 5.4 错误处理矩阵

| 失败点 | UI 反馈 | 用户可操作 |
|---|---|---|
| macapp 启动时 opencode 不可用 | 编码 tab 正常显示（无提示） | 点 tab 触发 install |
| autostart spawn 失败 | 编码 tab 正常显示 | 点 tab 触发 install |
| autostart health 超时（5s 未就绪） | 编码 tab 正常显示 + log error | 点 tab 触发 install |
| 编码 tab 点击 → Node.js 缺失 | ElNotification「请先安装 Node.js」+ 「打开 nodejs.org」 | 去装 Node.js |
| Node.js 版本过低（<18） | ElMessage.warning「建议升级 Node.js 到 18+」 | 装新版本（不阻断安装） |
| npm install 失败 | ElMessage.error「安装失败：${stderr 末尾 200 字}」 | 点「重试」按钮 |
| install 后仍 detect 不到 | ElMessage.error「安装后找不到 opencode 命令」 | 点「重试」或检查 PATH |
| spawn 失败 | ElMessage.error「启动失败：${message}」 | 点「重试」 |
| spawn 后 5s 未就绪 | 自动 kill + ElMessage.error「opencode 启动超时」 | 点「重试」 |
| opencode 运行中异常退出 | 推 `coding:status` `{state: 'exited', code}` + ElMessage.error + 编码 tab 变灰 | 点「重试」按钮 |
| 端口 4296-4300 全被占 | ElMessage.error「无可用端口」 | 改 config.port 重启 |

**统一原则**：所有错误用 Element Plus 现有组件（ElMessage / ElNotification），文案保持简短 + 给操作指引。

### 5.5 日志

复用现有 `logger.ts`（写 main.log）：

- 模块名 `coding`
- 关键事件打 info：autostart start/end、spawn cmd、port、ready、exit code、install start/result
- 失败打 error：spawn 失败原因、health 超时、install stderr
- opencode 进程的 stdout/stderr 接 logger（最近 200 行滚动 buffer 用于排障）

```ts
const log = logger.child('coding');
log.info(`autostart: detecting opencode...`);
log.info(`detected: binPath=${binPath}, version=${version}`);
log.info(`spawn: ${binPath} web --port ${port} --hostname 127.0.0.1`);
log.info(`ready: http://127.0.0.1:${port}`);
log.error(`spawn failed: ${err.message}`);
log.error(`install failed: ${stderr}`);
log.warn(`opencode exited unexpectedly: code=${code} signal=${signal}`);
```

### 5.6 与现有「retry IPC handler」的关系

`registerIpcHandlers(mode)` 注册 `retry:request` / `online:retry` 用于 contentView / offlineView 的重试。**不冲突**：coding 是独立的 IPC namespace，与 retry 解耦。

`before-quit` 同时调用 `closeLogger()` 和 `codingAgent.shutdown()`，顺序：先 shutdown（kill 进程 → 释放端口）→ 再 closeLogger（刷盘日志）。如果反过来可能丢日志。

---

## § 6 offline-app 集成 + 编码 tab UI

### 6.1 现有 UI 入口

[offline-app/src/data/assistantFeatures.ts:38-70](offline-app/src/data/assistantFeatures.ts#L38-L70)：`FeatureSection` 「算粒写」区块有「写代码」卡片。

[offline-app/src/data/assistantFeatures.ts:144-149](offline-app/src/data/assistantFeatures.ts#L144-L149)：`BottomTabBar` 第 4 个 tab `code`。

当前两者都只在 App.vue 里 console.log 占位（[App.vue:21](offline-app/src/App.vue#L21)）。

### 6.2 改动点

**新增事件 / 行为**：「写代码」卡片和 tab 点击时，**统一调用 `codingAgent.open()`**——打开编码 tab = 切换 WebContentsView 到 codingView（opencode web 内嵌）。

```ts
// App.vue（修改后）
function onCodeClick() {
  // 走 IPC：主进程检查 opencode，未装就静默装，装完 spawn，自动切 view
  window.electronAPI.coding.open().then((result) => {
    if (!result.ok) {
      // 错误已由主进程通过 ElMessage / ElNotification 反馈；前端无操作
      console.warn('[coding] open failed:', result.reason, result.message);
      return;
    }
    // result.ok 时主进程已自动 showOnly(codingView)（见 §3.1 view 切换归属），
    // 前端无需任何 view 操作；onStatus 订阅仅用于 toast 与 tab 视觉态
  });
}
```

**卡片和 tab 共用入口**：FeatureCard「写代码」和 BottomTabBar「写代码」tab 触发同一处理函数。**视觉反馈统一**：
- opencode 已 ready → 切到 codingView（秒开）
- 正在 installing / spawning → 卡片 / tab 显示 loading spinner + 「正在准备…」文字
- 异常退出 → 卡片 / tab 灰显 + 角标红点

### 6.3 新增 toast 工具

不需要新建 Vue 组件——复用 Element Plus 的 `ElMessage`（轻提示）和 `ElNotification`（带操作按钮的强提示）。

在 `offline-app/src/coding-toast.ts` 新增工具模块：

```ts
import { ElMessage, ElNotification } from 'element-plus';

export function codingToast(status: CodingStatus) {
  switch (status.state) {
    case 'installing':
      ElMessage.info({ message: '正在安装 opencode…', duration: 0, grouping: true });
      break;
    case 'spawning':
      ElMessage.info({ message: '正在启动 opencode…', duration: 0, grouping: true });
      break;
    case 'ready':
      ElMessage.closeAll();  // 关闭 installing / spawning
      break;
    case 'exited':
      ElMessage.error(`opencode 已退出 (code=${status.code})`);
      break;
    case 'spawn-failed':
    case 'timeout':
      ElMessage.error(status.message);
      break;
  }
}

export function notifyNoNode(message: string) {
  ElNotification({
    title: '需要 Node.js',
    message,
    duration: 0,  // 不自动关，用户点才走
    type: 'warning',
  });
}
```

### 6.4 ui store 扩展

[offline-app/src/stores/ui.ts](offline-app/src/stores/ui.ts) 新增 coding 状态：

```ts
export const useUiStore = defineStore('ui', () => {
  // 现有字段保留 ...

  // v1.1 新增
  const codingStatus = ref<CodingStatus>({ state: 'unavailable' });
  const isInCodingView = ref(false);  // 当前是否显示 codingView（用于 tab 高亮）

  function setCodingStatus(s: CodingStatus) { codingStatus.value = s; }
  function setInCodingView(v: boolean) { isInCodingView.value = v; }

  // 订阅主进程推送（HMR 清理沿用现有模式）
  if (window.electronAPI) {
    const unsubscribe = window.electronAPI.coding.onStatus((s) => {
      codingStatus.value = s;
      codingToast(s);  // 自动 toast 反馈
    });
    if (import.meta.hot) {
      import.meta.hot.dispose(() => unsubscribe());
    }
  }

  return {
    // 现有 ...
    codingStatus,
    isInCodingView,
    setCodingStatus,
    setInCodingView,
  };
});
```

### 6.5 与 FeatureSection / BottomTabBar 的接线

**最小改动**：把现有的 `console.log('... (offline)')` 占位替换成 `onCodeClick()`。

[App.vue](offline-app/src/App.vue) 新增：

```ts
function onCodeClick() {
  window.electronAPI.coding.open();
}
```

`AppCarousel`（AI 应用切换）和 `FeatureSection`（三大区块）的卡片 click 已经走 `onAppSelect` / 占位逻辑；新增「写代码」卡片专用 click 处理：在 `FeatureSection` 卡片数据里加 `action?: 'coding' | null` 字段，App.vue 根据 action 决定走 `onCodeClick` 还是占位。

**最简实现**：在 `assistantFeatures.ts` 里给「写代码」卡片加 `action: 'coding'`：

```ts
{ title: '写代码', desc: '快速编写代码', icon: '💻', iconBg: '#dbeafe', action: 'coding' }
```

[App.vue](offline-app/src/App.vue) 的 `FeatureSection` 卡片 click 处理里判断 `card.action === 'coding'`，是则调 `onCodeClick`。

BottomTabBar 的 `code` tab 直接判定 id === 'code' 走 `onCodeClick`。

### 6.6 编码 view 内的返回按钮

opencode web 是黑盒，无返回按钮。**前端方案**：
- 编码 view 顶部覆盖一层透明 overlay（仅 macapp 自己的 UI）显示「← 返回」按钮
- 点击 → `window.electronAPI.coding.close()` → 主进程 `showOnly(offlineView)`
- overlay 仅在 codingView 可见时显示（其他 view 时 hidden）

**实现**：用 HTML 元素 + z-index，不能影响 opencode web 操作。

### 6.7 dev 模式兼容

`npm run dev:offline` 启动 Vite，无 Electron 主进程：
- `window.electronAPI` 为 undefined
- `onCodeClick` 检测到后只 console.log（沿用现有 offline 模式占位风格）

```ts
function onCodeClick() {
  if (window.electronAPI) {
    window.electronAPI.coding.open();
  } else {
    console.log('coding click (dev mode, no IPC)');
  }
}
```

---

## § 7 端口冲突 + 工作目录 + 安全 + 日志 + 测试

### 7.1 端口探测

`config.jsonc.codingAgent.port` 默认 4296。spawn 前探测占用：

```ts
async function pickPort(preferred: number, range = 5): Promise<number | null> {
  for (let p = preferred; p < preferred + range; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;  // 4296-4300 全占
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}
```

探测范围 5 个端口（4296-4300），都占就放弃 + ElMessage.error。

**端口归属检测**：探测到端口被占时，若占用者是另一个 opencode 进程（`lsof -i :4296` 看进程名），**复用而不重 spawn**；否则报「端口被其他程序占用」。本期简化：发现被占就跳下一个，不复用。

### 7.2 工作目录

`config.jsonc.codingAgent.defaultDir` 控制 opencode web 启动时的 cwd：

- 空字符串：用平台默认
  - macOS: `path.join(os.homedir(), 'Documents')`
  - Windows: `path.join(os.homedir())`（用户根目录）
- 非空：必须是存在的目录，否则 fallback 到平台默认 + warn

**本期不做**：UI 上让用户选择目录（v1.0 草案的 `dialog:showOpenDialog` 暂不暴露）。如果用户需要，让运维改 config.jsonc。

### 7.3 安全基线

| 项 | 措施 |
|---|---|
| 网络暴露 | `--hostname 127.0.0.1` 强制回环，shell `lsof -i :4296` 应仅 127.0.0.1 |
| 导航白名单 | codingView 只允许 `http://127.0.0.1:<actualPort>/*`，其余 preventDefault |
| 外链处理 | `https:` 链接走 `shell.openExternal`（对齐 contentView 处理） |
| sandbox | codingView `sandbox: false`（本地可信端口），但 `contextIsolation: true`、`nodeIntegration: false` |
| 安装源 | 本期仅支持官方 npm 包 `opencode-ai`；installSource 字段预留不解析；不暴露自定义命令执行 |
| 进程权限 | opencode 子进程继承 macapp 权限，detached: false（macapp 退出时一并回收） |
| 凭据 | opencode 的 model API key 存于 `~/.opencode` 或 `~/.config/opencode`，macapp 不读、不传 |
| 端口探测 | 仅绑 127.0.0.1，避免广域网扫描 |

### 7.4 日志文件位置

复用现有 [electron/logger.ts](electron/logger.ts) 的 `userData/main.log`。codingAgent 子模块的所有日志走 `logger.child('coding')`，自动带 `coding` 前缀，与 `main`、`config`、`updater` 平级。

opencode 进程 stdout/stderr 接 logger 的策略：
- 实时每行转发（`child.stdout.on('data', chunk => ...)`）
- 不写文件外的 ring buffer（避免 IPC 风暴）
- 仅用于排障，不做 UI 展示

### 7.5 测试策略

**单元测试**（vitest，新文件 `electron/codingAgent.test.ts`）：
- `detect()` 路径解析（mock child_process.spawnSync 返回不同 binPath）
- `pickPort()` 探测逻辑（mock net.createServer）
- `install()` npm 命令构造（mock child_process.spawn）
- 状态机：`unavailable → spawning → ready` / `ready → exited`

**集成测试**（手工）：
- M1 原型：手动装 opencode，验证 macapp 启动时 spawn，编码 tab 切 view 正常
- M2 install 路径：卸载 opencode，点编码 tab，验证静默安装 + spawn + 切 view 全流程
- M3 失败路径：删掉 npm / 改 PATH / 占满端口 / 装 Node < 18，验证 toast 反馈正确

**E2E**（不写代码，本期不做）：
- 真实用户的全流程验证走 M3 手工 + 内部试用

### 7.6 与现有测试基础设施的关系

仓库目前没有 vitest / mocha 配置（package.json 仅 devDependencies 是构建工具）。测试代码本期**只写不跑**：
- 写好 `codingAgent.test.ts` 放在 `electron/` 下
- 等后续引入 vitest 时一并接入
- 不为本期单独引入测试框架（YAGNI）

### 7.7 边界 case 处理

| Case | 处理 |
|---|---|
| 用户在 macapp 启动前手动 kill opencode | 下次启动 autostart 时 detect 失败 → 编码 tab 走 install 路径 |
| opencode 在运行中版本被 npm upgrade | 不感知（运行中进程仍为旧版本）；下次 macapp 启动时用新版本 |
| 编码 view 加载中 opencode 退出 | 捕获 `did-fail-load` 事件 → 推 coding:status → UI 回 offline 页 |
| macOS TCC：Documents 目录不可访问 | spawn 失败 → log error，编码 tab 走 install 路径重试（cwd fallback 到 home） |
| Windows 长路径（>260 字符） | 用 `\\\\?\\` 前缀（仅 spawn 配置，cwd 已是绝对路径） |
| 用户在 macapp 运行中重启电脑 | before-quit 触发不了；下次启动时 `isPortFree(4296)` 自动探测 |

---

## § 8 实施里程碑 + 风险 + 后续演进

### 8.1 实施里程碑

#### M1 原型验证（0.5 ~ 1 天）

- 手动装 opencode（`npm i -g opencode-ai`）
- 手动启 `opencode web`，验证 Web UI 可用
- 主进程加最小 codingAgent（detect + spawn + shutdown）
- 验证 macapp 启动 → spawn → 编码 tab 切 view
- **产出**：截图给评审；证明「壳 + 本地 Web」跑通

#### M2 完整功能（3 ~ 4 天）

| 子任务 | 估时 |
|---|---|
| codingAgent 完整实现（detect/install/spawn/health/lifecycle） | 1.5d |
| config.jsonc 扩展 + 校验 + 迁移 | 0.5d |
| preload IPC + main.ts IPC handlers + codingView 改造 | 0.5d |
| offline-app UI 接线（FeatureCard / BottomTabBar / ui store / toast） | 0.5d |
| 错误处理 + 日志 + 端口探测 + 工作目录 fallback | 0.5d |
| 单元测试（codingAgent.test.ts，不跑） | 0.5d |

#### M3 增强（可选）

- opencode 自更新提示（检测版本 + toast「可升级」）
- 编码 view overlay 返回按钮 + opencode web 主题适配
- 工作目录 UI 选择（dialog.showOpenDialog）
- 写代码 tab 拖拽目录到 overlay 直接 cd
- `installSource` 字段真实解析（npm registry / 自定义命令）

### 8.2 风险与对策

| 风险 | 影响 | 概率 | 对策 |
|---|---|---|---|
| opencode web UI 功能弱于 TUI | 编码体验打折 | 中 | M1 真实场景验证；不足则 M3 评估 xterm.js 或 opencode attach |
| npm i -g 权限失败（全局包需要 sudo） | macOS/Linux 用户可能装不上 | 中 | 提示用户用 `sudo npm i -g` 或改用 nvm 管理；推荐 Node.js installer 自带 npm 不需要 sudo |
| Node.js 缺失率高 | 用户首次点编码 tab 都被劝退 | 中 | 安装引导文案明确指向 nodejs.org；考虑 M3 加 bundle Node.js 选项 |
| macOS TCC：Documents 不可访问 | opencode 没法读代码 | 低 | spawn cwd fallback 到 `~/`，toast 提示 |
| 端口冲突（用户开了 4296-4300 别的服务） | 编码 tab 启动失败 | 低 | 自动跳端口；都占则明确报错 |
| opencode 子进程残留（崩溃/强杀） | 端口被僵尸占用 | 中 | `before-quit` 回收 + 启动时端口探测失败自动跳下一个 |
| macOS activate 重开窗口不触发 autostart | 用户体验不一致 | 低 | 显式约束：autostart 仅在 `app.whenReady().then` 第一次跑；activate 不重复 |
| config.jsonc 字段缺失（旧用户升级） | autostart 行为不一致 | 低 | 复用现有「缺字段从 bundled 补齐」迁移，自动加默认值 |
| opencode 版本升级破坏兼容 | spawn 参数变化 | 低 | spawn 参数集中封装；M3 加版本检查 + 提示 |

### 8.3 与 v1.0 草案的兼容性

**保留 v1.0 全部已有内容**：
- §4.1 五个字段（enable / binPath / installSource / port / defaultDir）
- §4.4 IPC 接口命名（coding.open / close / status / install / onStatus / onInstallProgress / chooseDir）
- §4.5 codingView 架构
- §4.6 导航白名单
- §4.8 生命周期（v1.0 已有的部分）
- §4.9 日志
- §4.10 安全基线
- M1/M2/M3 里程碑框架

**v1.1 增量**：
- §4.1 新增 `autostart` 字段
- §4.4 IPC 接口子集化（保留 open/close/onStatus，新增 retry；install / chooseDir 暂不暴露）
- §5 启动期 spawn + autostart 决策树
- §6 install 路径（v1.0 没明确说怎么装）
- §6.3 / 6.4 install 静默 + toast 反馈（v1.0 是 wizard UI）

**废弃 v1.0 草案的**：
- §2.3「按需引导安装（first-use），不捆绑」措辞 → 改为「按需静默安装（first-use）」；语义不变，仅 UI 形式从 wizard 改为 toast
- §4.2 安装检测与引导的引导页 → 改为 toast（§3.3）
- §4.4 IPC 的 `install` / `chooseDir` / `status` → 删 / 改 onStatus / 不暴露（v1.1 仅保留必需接口）
- §7 待确认问题 1 / 4 / 5 → 在 v1.1 决策里已回答（自启时机 / Windows 同步 / UI 入口位置）

**未回答**（沿用 v1.0 §7）：
- 模型 provider 与计费（用户自带 key vs 公司网关）
- 内网 npm 镜像（installSource 字段预留）

### 8.4 后续演进（非本期）

- **远程化**：opencode serve 部署到公司服务器，macapp 直接加载远程 Web UI
- **账号体系对接**：服务端代理统一认证 / 计费 / 审计
- **TUI 增强**：若 Web UI 不够，node-pty + xterm.js 或 `opencode run --attach`
- **自有前端**：基于 opencode HTTP API 自研 coding 页（接口已开放）
- **AI Agent 广场联动**：后端 agent-user 的「写代码」按钮 deep link `suanli://coding?dir=...` 唤起本地服务
- **公司 npm 私服**：installSource 字段真实解析，支持内网 `npm install -g opencode-ai --registry=https://npm.internal/`

### 8.5 验收标准（M2 完成时）

- [ ] macOS / Windows 上全新安装 macapp → 启动 → 编码 tab 可见
- [ ] 未装 opencode 时点编码 tab → toast「正在安装…」 → 安装成功后自动切到 opencode web
- [ ] 未装 Node.js 时点编码 tab → ElNotification 提示去 nodejs.org
- [ ] 已装 opencode 时启动 macapp → 后台日志见 `coding: ready http://127.0.0.1:4296`
- [ ] 点编码 tab → 秒切到 codingView
- [ ] 切走再切回 → 不重新 spawn（会话保持）
- [ ] macapp 退出 → 日志见 `coding: opencode killed`
- [ ] 手动 kill opencode 进程 → 编码 tab 变灰 + toast「opencode 已退出」
- [ ] 端口 4296 被占 → 自动跳 4297，日志见 `coding: port fallback to 4297`
- [ ] 关闭 macapp 重启 → 状态正确恢复
