# 应用启动日志 — 设计文档

日期：2026-08-21
主题：自研 logger 模块，把应用启动全流程 + 关键事件记录到日志文件，便于排查定位。零依赖、跨平台一致、与 codesign 兼容。

## 背景

2026-08-20 完成「config.jsonc 跨平台可编辑」改造后，应用主进程已在 `electron/main.ts`、`electron/config.ts` 中使用 `console.log/error/warn` 打印关键事件（启动序列、config 加载、URL 重试、窗口创建、错误页等共约 25 处）。但这些日志只在终端可见：

- dev 模式（`npm run dev:electron`）开发者能看到终端
- 打包后用户双击 `.app` 或 `.exe` 启动，**终端完全看不到**，只能去 DevTools 看渲染进程
- 启动期就失败的场景（config 加载失败、bundled 缺失）连 DevTools 都进不去，只能看进程是否启动

核心问题：

- 用户/运维反馈「应用启动后窗口不显示」「加载失败」时，**无法定位是 config 问题、URL 问题、还是窗口创建问题**
- macOS `/Applications` 安装后，用户甚至无法直接看到 stderr（已 detach）
- 没有日志文件 → 排查靠用户口述，效率低

## 目标

1. **跨平台一致**：macOS 和 Windows 用户都能访问日志文件排查
2. **遵循规范**：使用 `app.getPath('userData')/logs/main.log`（与 config.jsonc 同级模型，codesign 兼容）
3. **零依赖**：纯 Node fs API，不引入 winston/pino 等第三方 logger
4. **不阻断应用**：logger 自身任何故障都不能让应用无法启动
5. **不丢关键日志**：进程退出前 flush 完整
6. **主+渲染进程**：主进程日志 + 渲染进程日志都进同一文件
7. **可控制大小**：单文件上限 5MB，超过轮转保留 3 个备份

## 设计

### 1. 架构

```
electron/
├── logger.ts          ← 新增：核心模块（child logger + 写入 + 轮转 + IPC 注册）
├── main.ts            ← 改：替换关键 console.* 为 logger.child('xxx').*
├── config.ts          ← 改：替换 console.* 为 logger.child('config').*
└── preload.ts         ← 改：通过 contextBridge 暴露 window.electronAPI.log

dist-electron/
└── main.js            ← esbuild 自动包含 logger.js

userData/
└── logs/
    ├── main.log       ← 当前活跃日志（轮转触发时变 main.log.1）
    ├── main.log.1
    ├── main.log.2
    └── main.log.3
```

### 2. 模块 API

**`electron/logger.ts` 公开 API**

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** 创建子 logger，输出前缀拼接 [parent.child] */
  child(module: string): Logger;
}

/** 顶层 logger（initLogger 之前调用 fallback 到 console） */
export const logger: Logger;

/** 初始化：创建目录、轮转、写 header；必须在 app.whenReady() 之后调用 */
export function initLogger(): void;

/** 注册 ipcMain.handle('log:write')，供渲染进程调用 */
export function registerLogHandlers(): void;

/** 关闭：写 footer；进程退出前调用 */
export function closeLogger(): void;
```

### 3. 日志格式

**单行格式**：

```
2026-08-21T12:34:56.789 [INFO] [config] ✓ 已加载 /Users/.../config.jsonc
```

- 时间戳：ISO 8601 毫秒精度，本地时区
- 级别：`[DEBUG]` / `[INFO]` / `[WARN]` / `[ERROR]`
- 模块：`[config]` / `[main]` / `[renderer]` / 嵌套（如 `[config.copy]`）
- 消息：原始 message 字符串

**文件 header**（每次启动写入）：

```
=== log started at 2026-08-21T12:34:56.789 (macos, electron 43.4.1) ===
```

**文件 footer**（进程退出前写入）：

```
=== log ended at 2026-08-21T12:35:42.123 ===
```

### 4. 路径解析

**`getLogFilePath()`**（`logger.ts` 私有函数）

```ts
function getLogFilePath(): string {
  return path.join(app.getPath('userData'), 'logs', 'main.log');
}
```

**跨平台落地**：

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/算粒AI助手/logs/main.log` |
| Windows | `%APPDATA%\算粒AI助手\logs\main.log` |

### 5. 写入策略

**同步写入**：使用 `fs.appendFileSync`，保证：
- 进程退出时未 flush 的日志不丢失
- 写入顺序与调用顺序一致
- 单条日志 < 1KB 同步开销可忽略

**大小检查**：每次写入后，检查 `main.log` 字节数：
- < 5MB → 继续
- ≥ 5MB → 触发轮转

### 6. 轮转

**触发时机**：写入后检测到 `main.log` ≥ 5MB

**轮转算法**（类似 logrotate copytruncate）：

```
轮转前：
  main.log       (5MB)
  main.log.1     (3MB)
  main.log.2     (2MB)
  main.log.3     (1MB)

轮转后：
  main.log       (0B，下次写入新建)
  main.log.1     (5MB，从 main.log 改名)
  main.log.2     (3MB，从 main.log.1 改名)
  main.log.3     (2MB，从 main.log.2 改名)
  (main.log.3 旧文件被删除)
```

**实现**：

```ts
function rotate(): void {
  // 从最老开始删（避免移位）
  if (fs.existsSync(LOG_PATH_3)) fs.unlinkSync(LOG_PATH_3);
  if (fs.existsSync(LOG_PATH_2)) fs.renameSync(LOG_PATH_2, LOG_PATH_3);
  if (fs.existsSync(LOG_PATH_1)) fs.renameSync(LOG_PATH_1, LOG_PATH_2);
  if (fs.existsSync(LOG_PATH))   fs.renameSync(LOG_PATH,   LOG_PATH_1);
}
```

**冷启动时检测**：`initLogger()` 调用时先执行一次 `rotateIfNeeded()`，处理「上次会话写了 5MB 但忘了 rotate」的情况。

### 7. 主进程接入

**`main.ts` 关键日志点**：

```ts
import { logger, initLogger, registerLogHandlers, closeLogger } from './logger';
const log = logger.child('main');

// app.whenReady 内
app.whenReady().then(async () => {
  initLogger();
  log.info('app ready');
  registerLogHandlers();
  
  const config = await loadConfig();
  log.info(`createMainWindow: ${config.width}x${config.height}`);
  createMainWindow(config);
  
  // ...原有代码
});

// 进程退出
app.on('before-quit', () => {
  log.info('app quitting');
  closeLogger();
});
```

**`config.ts` 关键日志点**：

```ts
const log = logger.child('config');

// resolveConfigPath 中
log.info(`✓ 已初始化用户配置: ${userConfigPath}`);
log.warn(`⚠ 无法写入 userData: ${err.message}`);
log.warn(`  回退到 bundled default（用户编辑不会持久化）: ${bundledPath}`);

// loadConfig 中
log.info(`✓ 已加载 ${configPath}`);
log.info(`  targetUrl: ${validated.targetUrl}`);
log.info(`  窗口: ${validated.width}x${validated.height} (min ${validated.minWidth}x${validated.minHeight})`);
log.info(`  重试: ${validated.maxRetries} 次, 间隔 ${validated.retryDelayMs}ms`);
```

**保留 `console.error` + `process.exit(1)`**：config 加载失败仍然用 console.error 打印到 stderr（因为 logger 可能在 initLogger 之前被调用，且 exit 场景下 console 能立刻 flush）。

### 8. 渲染进程接入

**`preload.ts`**：

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
  retry: () => ipcRenderer.send('retry:request'),
  // 新增
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.invoke('log:write', level, message);
  },
});
```

**`main.ts`（注册 handler）**：

```ts
function registerLogHandlers() {
  ipcMain.handle('log:write', (_event, level: string, message: string) => {
    const rendererLog = logger.child('renderer');
    switch (level) {
      case 'debug': rendererLog.debug(message); break;
      case 'info':  rendererLog.info(message); break;
      case 'warn':  rendererLog.warn(message); break;
      case 'error': rendererLog.error(message); break;
      default:      rendererLog.info(`[level=${level}] ${message}`);
    }
  });
}
```

**渲染进程调用示例**（splash.html / retry.html 中的 JS）：

```ts
window.electronAPI.log('info', 'splash shown');
window.electronAPI.log('error', 'retry exhausted');
```

### 9. 错误处理与兜底

| 场景 | 行为 |
|------|------|
| `initLogger()` 在 `app.whenReady()` 之前调用 | throw（由 main.ts 调用顺序保证） |
| `userData/logs/` 目录创建失败（EACCES） | console.error + 后续所有写入静默失败（不抛） |
| `appendFileSync` 抛错（磁盘满） | console.error + 后续继续尝试 |
| rotate 失败（EACCES 等） | console.error + 保留旧文件，下次启动再试 |
| IPC 接收渲染进程日志时主进程 logger 未初始化 | handler 不存在 → invoke 静默失败 |
| 进程异常退出（segfault） | closeLogger 未调用 → 日志无 footer，但已写入的数据完整 |

**fallback 设计**：

```ts
let initialized = false;
let logFilePath: string | null = null;

function write(level: LogLevel, module: string, message: string): void {
  const line = formatLine(level, module, message);
  
  // console 始终输出（dev 模式终端可见）
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  
  // 文件写入（如果已初始化）
  if (!initialized || !logFilePath) return;
  
  try {
    fs.appendFileSync(logFilePath, line + '\n');
    rotateIfNeeded();
  } catch (err) {
    // 单条写入失败 → console 警告 + 继续（不抛）
    console.error(`[logger] 写入失败: ${(err as Error).message}`);
  }
}
```

**核心原则**：logger 任何环节失败都 fallback 到 console，绝不阻断应用。

### 10. 初始化顺序硬约束

`main.ts` 中的调用顺序（修改前 → 修改后）：

```diff
+import { logger, initLogger, registerLogHandlers, closeLogger } from './logger';

 // loadConfig() 是 async...
 app.whenReady().then(async () => {
+  initLogger();
+  logger.child('main').info('app ready');
+  registerLogHandlers();
+
   const config = await loadConfig();
   createMainWindow(config);
   // ...
 });

+app.on('before-quit', () => {
+  logger.child('main').info('app quitting');
+  closeLogger();
+});
```

### 11. esbuild 配置

`scripts/build-electron.js` 默认 bundle `electron/main.ts` 所有 import，包括 `./logger`。无需修改 esbuild 配置。

`logger.ts` 依赖 `electron`（仅 `app`），需要保持 external：

```js
// scripts/build-electron.js 已配置 external: ['electron']
```

### 12. 跨平台路径效果

| 部署方式 | 日志文件路径 |
|---------|------------|
| dev（`npm run dev:electron`） | `~/Library/Application Support/算粒AI助手/logs/main.log`（macOS）<br>`%APPDATA%\算粒AI助手\logs\main.log`（Windows）<br>即 `app.getPath('userData')/logs/main.log` |
| Windows NSIS 安装 | `%APPDATA%\算粒AI助手\logs\main.log` |
| Windows 免安装 | `%APPDATA%\算粒AI助手\logs\main.log` |
| macOS 任意位置 | `~/Library/Application Support/算粒AI助手/logs/main.log` |

### 13. README 新增章节

```markdown
## 📋 日志文件

应用启动后会写入日志到 `userData/logs/main.log`，便于排查启动问题：

- **macOS**：`~/Library/Application Support/算粒AI助手/logs/main.log`
- **Windows**：`%APPDATA%\算粒AI助手\logs\main.log`

### 日志轮转

- 单文件上限 5MB
- 超过时轮转：`main.log` → `main.log.1` → ... → `main.log.3`
- 最老的 `main.log.3` 被丢弃
- 最多保留 3 个备份，总量 20MB

### 日志格式

每行格式：`2026-08-21T12:34:56.789 [LEVEL] [module] message`

每次启动写入 header：`=== log started at <ISO> ===`
进程退出前写入 footer：`=== log ended at <ISO> ===`

### 常见用法

```bash
# macOS 查看最新日志
tail -f ~/Library/Application\ Support/算粒AI助手/logs/main.log

# Windows 查看最新日志
type %APPDATA%\算粒AI助手\logs\main.log

# 清空日志（保留目录）
rm ~/Library/Application\ Support/算粒AI助手/logs/main.log*
```
```

## 范围

本设计**不**包含：

- ❌ 结构化日志（JSON Lines）
- ❌ 日志级别运行时切换（`LOG_LEVEL` 环境变量）
- ❌ 远程日志上报（Sentry / 远程 endpoint）
- ❌ 日志加密 / 脱敏（包含用户隐私字段）
- ❌ logrotate 外部工具集成
- ❌ macOS 打包验证（需 Mac，CI 兜底）
- ❌ 自动化测试（项目无测试基建）
- ❌ 异步写入（同步写入已足够，不增加复杂度）
- ❌ 日志采样（按概率丢弃部分 debug 日志）

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 同步写入阻塞主进程 | 写盘卡顿影响 UI | 日志频率低（< 50 条/会话），单条 < 1KB，开销可忽略 |
| 用户删除日志目录 | 下次启动时 appendFileSync 抛错 | catch 后 console.error，应用继续运行 |
| 用户禁用 userData 目录权限 | 整个应用无法启动？不，只是日志失败 | fallback 设计：日志失败不阻断 |
| macOS `app.getPath('userData')` 中文路径编码 | 路径错误 | Node fs 默认 UTF-8，实测无问题 |
| `initLogger` 之前收到 IPC 消息 | 渲染进程 invoke 失败 | 渲染进程在 splash 后才创建，initLogger 先于 createMainWindow |
| 多窗口同时写日志导致顺序错乱 | 日志顺序混乱 | main.ts 中所有 log 调用都在同一个 main process 线程，单线程串行无问题 |
| `rotateIfNeeded` 在 5MB 边界上抖动 | 频繁 rotate | 检查时使用 `>= 5MB` 阈值，写入前已增长的部分保留 |
| 日志泄露敏感信息（targetUrl 包含内网地址） | 隐私泄露 | targetUrl 本就是用户可编辑的配置，不算敏感；其他字段都是公开运行时信息 |

## 验收标准

### dev 模式

1. **首次启动创建日志**：`npm run dev:electron` → `userData/logs/main.log` 创建 + 包含 header
2. **config 加载日志**：main.log 包含 `[INFO] [config] ✓ 已加载 ...` + 4 行配置详情
3. **main 启动日志**：main.log 包含 `[INFO] [main] app ready` + `[INFO] [main] createMainWindow ...`
4. **渲染进程日志**：在 DevTools console 调 `window.electronAPI.log('error', 'test')` → main.log 包含 `[ERROR] [renderer] test`

### Windows 打包

5. **首次启动创建日志**：安装后首次启动 → `%APPDATA%\算粒AI助手\logs\main.log` 存在
6. **重启不丢日志**：再次启动 → 旧 main.log 不被覆盖（append 模式）
7. **5MB 轮转**：手动复制大量日志进 main.log 使其 > 5MB → 重启 → 触发 rotate，main.log.1/2/3 正确生成
8. **冷启动 rotate**：上次会话最后写入使 main.log = 5MB → 下次启动 initLogger 检测到并 rotate

### macOS 打包

9. **首次启动创建日志**：安装后 → `~/Library/Application Support/算粒AI助手/logs/main.log` 存在
10. **codesign 不破坏**：应用包 `.app` 签名通过（验证 /Applications 安装场景）

### 降级路径

11. **userData 不可写**：chmod 拒绝写入 → 应用仍能启动，console 出现「日志写入失败」警告
12. **logger 初始化异常**：手动 throw 模拟 → 不阻断 main.ts 后续流程（initLogger 在 try-catch 中）
13. **IPC 消息但 logger 未初始化**：渲染进程 invoke 失败静默

### 文档

14. README 新章节齐全，路径、格式、轮转、常见命令都写清楚

## 后续可选（不在本次范围）

- 引入 vitest 测试 logger 6 个核心场景（rotate / write / fallback / IPC / init order）
- 结构化日志（JSON Lines 便于日志聚合工具）
- 日志级别运行时切换（`LOG_LEVEL=debug` 环境变量）
- 远程日志上报（Sentry for Electron）
- 日志压缩归档（轮转时 gzip 旧文件）
- macOS `Console.app` 集成（os_log 桥接）
- Windows Event Log 集成
- 日志查看器（应用内菜单「打开日志目录」按钮）

## 决策记录

| 决策 | 选择 | 否决项 |
|------|------|--------|
| Logger 库 | 自研（零依赖） | winston / pino / bunyan（依赖重、配置复杂） |
| 路径 | `app.getPath('userData')/logs/main.log` | 安装根目录（macOS 不可写）；`app.getPath('logs')`（Windows 位置略深） |
| 记录范围 | 启动全流程 + 关键事件 | 仅 error（信息不足）；debug 全量（文件过大） |
| 轮转策略 | 5MB + 3 个备份 | 不轮转（文件无限增长）；按日期分割（文件多） |
| 接口风格 | `logger.child('xxx')` 命名空间 | 全局 `logger.info(module, msg)`（冗余）；`console.*` 重写（侵入性强） |
| 写入策略 | 同步写入（`appendFileSync`） | 异步写入（可能丢日志）；队列（复杂度） |
| 主+渲染集成 | preload 暴露 `electronAPI.log()` | 不集成（失去一半价值）；`webContents.console-message` 监听（被动、不可控） |
| 跨平台一致性 | 两平台都用 `userData/logs` | macOS 用 `~/Library/Logs`、Windows 用 `%APPDATA%`（路径不一致） |
| console 保留 | console.* 与 logger 并存 | 替换所有 console.*（侵入性强、风险高） |
| logger 失败处理 | fallback 到 console + 不抛 | throw 阻断应用（违反「不阻断」原则） |
| 初始化时机 | `app.whenReady()` 内同步调用 | 顶层调用（拿不到 `userData` 路径） |
| 测试 | 不引入测试框架 | vitest（用户明确不引入） |
| 数据格式 | 纯文本（时间 + 级别 + 模块 + 消息） | JSON Lines（机器友好但难肉眼读） |
| 进程退出 | `before-quit` hook 调 `closeLogger()` 写 footer | 不写 footer（损失边界信息） |
| 包大小影响 | 0（无依赖） | 增加 50-200KB（winston 等） |