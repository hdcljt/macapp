# Electron 应用外置 JSONC 配置 — 设计文档

日期：2026-08-20
主题：将 `electron/main.ts` 中硬编码的 7 个常量（`TARGET_URL` / `MAX_RETRIES` / `RETRY_DELAY_MS` / 4 个 BrowserWindow 尺寸）抽离到外部 JSONC 配置文件，应用启动时按平台特定路径读取。

## 背景

`electron/main.ts` 当前硬编码 7 个值：

```ts
const TARGET_URL = 'http://localhost:5195/agent-user/assistant';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
// BrowserWindow 构造：
width: 1180, height: 820, minWidth: 900, minHeight: 700,
```

约束：

- 目标后端 URL 在不同环境（dev / staging / prod）需要切换
- 终端用户希望自定义窗口尺寸、重试行为
- `will-navigate` 拦截硬编码 `http://localhost:5195/`，与 `TARGET_URL` 重复维护

本设计将上述全部抽离到 `config.jsonc`，应用启动时读取；启动期修改需重启（不支持热重载）。

## 目标

1. 仓库根 `config.jsonc` 是单一配置源（git 跟踪，同时是模板与默认值）
2. 打包后 `config.jsonc` 出现在用户可发现的位置（macOS Finder 可见、Windows 用户可编辑）
3. 跨平台路径解析统一，dev / 打包安装 / 免安装三种部署方式都能正确读取
4. 配置缺失或字段错误**硬失败**：打印错误信息并退出非零
5. 不引入热重载、不引入用户界面配置编辑器
6. 沿用现有 JSONC 解析能力（仅增加 `jsonc-parser` 依赖）

## 设计

### 1. 架构

```
electron/
├── main.ts            ← 现有文件，顶部 await loadConfig()，消费 config.*
├── config.ts          ← 新增：路径解析、读取、JSONC 解析、校验、退出
└── preload.ts         ← 不变

config.jsonc          ← 新增（仓库根，git 跟踪）：单一来源；同时是模板与默认值
```

| 模块 | 职责 |
|------|------|
| `config.ts` | 解析 `config.jsonc` 路径、读文件、JSONC 解析、字段校验、失败时 `console.error` + `process.exit(1)`、暴露 `AppConfig` 类型与 `allowedOriginPrefix` |
| `main.ts` | 启动时 `loadConfig()`、用 `config.targetUrl` 等替换硬编码常量、用 `config.allowedOriginPrefix` 替换 `will-navigate` 中的 origin 字面量 |

### 2. Schema

**`AppConfig` TypeScript 类型**（`config.ts` 导出）

```ts
export interface AppConfig {
  /** 目标 URL（Agent 用户助手入口），仅接受 http:// 与 https:// */
  targetUrl: string;
  /** 最大重试次数（≥ 0 整数） */
  maxRetries: number;
  /** 每次重试间隔毫秒（≥ 0 整数） */
  retryDelayMs: number;
  /** 窗口初始宽度（≥ minWidth 整数） */
  width: number;
  /** 窗口初始高度（≥ minHeight 整数） */
  height: number;
  /** 窗口最小宽度（≥ 1 整数） */
  minWidth: number;
  /** 窗口最小高度（≥ 1 整数） */
  minHeight: number;
}

export interface LoadedConfig extends AppConfig {
  /** 由 targetUrl 推导，供 will-navigate 使用 */
  allowedOriginPrefix: string;
}
```

**`config.jsonc`（仓库根，git 跟踪）**

```jsonc
{
  // 目标 URL：Electron 启动后 contentView 会加载此地址
  // will-navigate 拦截从此字段推导 origin；仅接受 http:// 与 https://
  "targetUrl": "http://localhost:5195/agent-user/assistant",

  // 目标 URL 加载失败时的重试次数。设为 0 表示不重试，直接进入错误页
  "maxRetries": 3,

  // 每次重试间隔（毫秒）。覆盖 ERR_CONNECTION_REFUSED 等所有错误
  "retryDelayMs": 5000,

  // BrowserWindow 初始尺寸（整数；width 必须 >= minWidth；height 必须 >= minHeight）
  "width": 1180,
  "height": 820,

  // BrowserWindow 最小尺寸（resize 时不低于此值）
  "minWidth": 900,
  "minHeight": 700
}
```

**校验规则**（`config.ts: validateConfig()`）

| 字段 | 校验 | 失败提示 |
|------|------|---------|
| `targetUrl` | 非空字符串、必须以 `http://` 或 `https://` 开头、`new URL()` 可解析 | `targetUrl 必须是合法的 http(s) URL` |
| `maxRetries` | `Number.isInteger(x) && x >= 0` | `maxRetries 必须是非负整数` |
| `retryDelayMs` | `Number.isInteger(x) && x >= 0` | `retryDelayMs 必须是非负整数` |
| `width` | `Number.isInteger(x) && x >= minWidth` | `width (W) 必须 >= minWidth (M)` |
| `height` | `Number.isInteger(x) && x >= minHeight` | `height (H) 必须 >= minHeight (M)` |
| `minWidth` | `Number.isInteger(x) && x >= 1` | `minWidth 必须是 >= 1 的整数` |
| `minHeight` | `Number.isInteger(x) && x >= 1` | `minHeight 必须是 >= 1 的整数` |

- 所有 7 个字段必须存在（无默认值、无 fallback），缺失即报 `字段 X 缺失`
- 校验失败时错误信息包含路径、字段名、原因

**错误输出示例**

```
[config] ✗ 字段校验失败：/Applications/算粒AI助手.app/Contents/Resources/config.jsonc
  - targetUrl: 必须是合法的 http(s) URL (实际: "localhost:5195/...")
  - maxRetries: 必须是非负整数 (实际: -1)
  - width (800): 必须 >= minWidth (950)
启动失败 (exit 1)
```

### 3. 路径解析与加载

**路径解析顺序**（`config.ts: resolveConfigPath()`）

```
1. 平台特定 exe-dir 路径
   ├─ darwin:  path.join(path.dirname(path.dirname(process.execPath)), 'Resources', 'config.jsonc')
   │           = .app/Contents/Resources/config.jsonc
   └─ 其他:    path.join(path.dirname(process.execPath), 'config.jsonc')
               = <install_dir>/config.jsonc （与 .exe 同级）
   ← 命中即返回

2. 仅当 app.isPackaged === false 且 1 不存在：
   path.join(process.cwd(), 'config.jsonc')
   ← dev 模式 fallback（npm run dev:electron 在项目根运行）

3. 都不存在 → 抛 ConfigNotFoundError（硬失败，列出 1+2 路径 + 复制提示）
```

**说明：为何不包含 userData 兜底层**

tier 1 在打包场景下**始终存在**（mac 用 `mac.extraResources`、win 用 `win.extraFiles` 保证 `config.jsonc` 已拷贝），任何 userData 兜底都**永远不会被命中**——这是逻辑冗余。spec v1 草案曾包含 userData 兜底，但自检时发现该层不可达，故删除。

macOS `/Applications/` 写权限限制作为已知问题保留到「后续可选」（应用内"编辑配置"按钮、userData override 等留待后续设计）。

**为什么 macOS 路径要向上跳一级**

electron-builder `mac.extraResources` 在 macOS 上落到 `<productFilename>.app/Contents/Resources/config.jsonc`（macOS bundle 标准资源目录）。`process.execPath` = `Contents/MacOS/算粒AI助手`，所以 `path.dirname(path.dirname(process.execPath))` 跳到 `Contents/`，再拼 `Resources/config.jsonc` 才能命中。

> **早期设计备注**：v1 用 `extraFiles` 让 macOS 落到 `Contents/config.jsonc`，但 codesign 拒绝签名 `Contents/` 根目录的非代码文件（报 `code object is not signed at all`）。改用 `mac.extraResources` 后落地到 `Contents/Resources/` 才符合 macOS bundle 规范，签名通过。

**加载流程**

```
启动 → 顶层 await loadConfig()
  ├─ resolveConfigPath() → 返回 config.jsonc 绝对路径
  ├─ fs.readFileSync(path, 'utf-8')
  ├─ jsonc-parser.parse(text, errors, { allowTrailingComma: true })
  │   ├─ 语法错误 → 抛 ConfigParseError（含错误信息+行号）
  │   └─ 返回对象 → validateConfig(obj)
  │       ├─ 缺字段/类型/范围错误 → 抛 ConfigValidationError
  │       └─ 通过 → 计算 allowedOriginPrefix = new URL(targetUrl).origin + '/'
  └─ 返回 LoadedConfig

任一阶段失败：
  console.error('[config] ✗', err.message)
  console.error('[config]   路径: ' + configPath)
  console.error('[config]   已尝试: ...')
  process.exit(1)
```

**JSONC 解析**

```ts
import { parse, ParseError } from 'jsonc-parser';

const errors: ParseError[] = [];
const data = parse(text, errors, { allowTrailingComma: true });
if (errors.length > 0) {
  const e = errors[0];
  throw new ConfigParseError(`第 ${e.offset + 1} 字符附近: ${e.error}`);
}
```

**成功启动输出**

```
[config] ✓ 已加载 /d:/hudc/git/gitlab/pc/macapp/config.jsonc
[config]   targetUrl: http://localhost:5195/agent-user/assistant
[config]   窗口: 1180x820 (min 900x700)
[config]   重试: 3 次, 间隔 5000ms
```

### 4. main.ts 集成

**diff 摘要**

```diff
 import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron';
 import path from 'node:path';
+import { loadConfig } from './config';

-const isDev = !app.isPackaged;
-const TARGET_URL = 'http://localhost:5195/agent-user/assistant';
-const MAX_RETRIES = 3;
-const RETRY_DELAY_MS = 5000;
+// 顶层 await：在 app.whenReady() 之前完成；失败由 config.ts 内部 process.exit(1)
+const config = await loadConfig();
+const isDev = !app.isPackaged;
+const TARGET_URL = config.targetUrl;
+const MAX_RETRIES = config.maxRetries;
+const RETRY_DELAY_MS = config.retryDelayMs;
+const ALLOWED_ORIGIN_PREFIX = config.allowedOriginPrefix;
```

**`createMainWindow` 内的替换**

| 当前（main.ts） | 替换为 |
|----------------|--------|
| `width: 1180,` | `width: config.width,` |
| `height: 820,` | `height: config.height,` |
| `minWidth: 900,` | `minWidth: config.minWidth,` |
| `minHeight: 700,` | `minHeight: config.minHeight,` |
| `if (!url.startsWith('http://localhost:5195/'))` | `if (!url.startsWith(ALLOWED_ORIGIN_PREFIX))` |

**为什么保留 `TARGET_URL` 等局部 const**

`TARGET_URL` / `MAX_RETRIES` / `RETRY_DELAY_MS` 在 `createMainWindow` 闭包内多处使用（line 91, 115, 117, 119, 130）。改为顶层 const 后局部仍可引用，最小化函数签名变化。

**esbuild 配置变更**（`scripts/build-electron.js`）

顶层 `await` 在 `format: 'cjs'` 下需要显式启用：

```diff
 await build({
   entryPoints: [path.join(root, 'electron/main.ts')],
   outfile: path.join(outdir, 'main.js'),
   bundle: true,
   platform: 'node',
   target: 'node18',
   format: 'cjs',
   external: ['electron'],
+  topLevelAwait: true,
   sourcemap: true,
   logLevel: 'info',
 });
```

### 5. 构建/分发

**`package.json` 变更**

```diff
   "devDependencies": {
     "@types/node": "^26.2.0",
     "cross-env": "^10.1.0",
     "electron": "^43.4.1",
     "electron-builder": "^26.15.3",
     "esbuild": "^0.28.2",
+    "jsonc-parser": "^3.3.1",
     "sharp": "^0.35.3",
     "typescript": "^7.0.2"
   },
   "build": {
     "files": ["dist-electron/**/*", "package.json"],
     "extraResources": [
       { "from": "build/icon.png", "to": "icon.png" }
     ],
+    "mac": {
+      "extraResources": [
+        { "from": "config.jsonc", "to": "config.jsonc" }
+      ]
+    },
+    "win": {
+      "extraFiles": [
+        { "from": "config.jsonc", "to": "config.jsonc" }
+      ]
+    }
   }
```

**落地路径效果**

| 部署方式 | 运行时实际路径 |
|---------|--------------|
| dev (`npm run dev:electron`) | `<project_root>/config.jsonc`（tier 2 fallback） |
| Windows NSIS 安装（perMachine:false） | `%LOCALAPPDATA%\Programs\算粒AI助手\config.jsonc` |
| Windows 免安装（zip 解压） | `<exe-dir>/config.jsonc` |
| macOS 免安装（`.app` 任意目录） | `<productFilename>.app/Contents/Resources/config.jsonc` |
| macOS `/Applications/` 安装 | 同上（**只读**，用户无法编辑） |

**macOS `/Applications/` 写权限说明（已知限制）**

- `.app` 拖到 `/Applications/` 后，整个 `.app` 是 root-owned
- 用户**无法**编辑 `Contents/Resources/config.jsonc`（即使 Finder 可见）
- 此场景下用户接受默认值；如需自定义，需把 `.app` 移到 `~/Applications/` 或任意可写目录
- 应用内"编辑配置"按钮、userData override 等留待后续设计（见「后续可选」）

**`.gitignore` 新增**

```gitignore
# 打包输出内的 config.jsonc（构建产物）
release/**/config.jsonc
dist-electron/config.jsonc
```

仓库根 `config.jsonc` 必须提交，不在 ignore 列表。

**`README.md` 新增「配置文件」章节**

```markdown
## 配置文件

应用启动时按以下顺序查找 `config.jsonc`：

1. 平台特定 exe-dir 路径
   - macOS：`<productFilename>.app/Contents/Resources/config.jsonc`
   - Windows / Linux：`<exe-dir>/config.jsonc`
2. dev 模式：`process.cwd()/config.jsonc`

字段说明见仓库根 `config.jsonc` 内的 `//` 注释。
**修改后必须重启应用**——本设计不支持热重载。
```

### 6. 关键文件变更清单

| 文件 | 动作 |
|------|------|
| `electron/config.ts` | **新增**：路径解析、JSONC 解析、校验、退出 |
| `electron/main.ts` | **修改**：删除 7 个硬编码常量；顶层 `await loadConfig()`；构造 BrowserWindow 时用 `config.*`；`will-navigate` 用 `ALLOWED_ORIGIN_PREFIX` |
| `config.jsonc` | **新增**（仓库根）：git 跟踪的默认值 |
| `scripts/build-electron.js` | **修改**：esbuild 配置加 `topLevelAwait: true` |
| `package.json` | **修改**：devDependencies 加 `jsonc-parser`；build 加 `mac.extraResources` + `win.extraFiles` |
| `.gitignore` | **修改**：新增 `release/**/config.jsonc`、`dist-electron/config.jsonc` |
| `README.md` | **修改**：新增「配置文件」章节 |

### 7. 数据流示例

**dev 启动成功**

```
1. npm run dev:electron
2. node scripts/build-electron.js → 编译 main.ts（含顶层 await）
3. node scripts/launch-electron.js → electron .
4. main.js 顶层: const config = await loadConfig()
5. resolveConfigPath():
   - 平台 win32: <exe-dir> 不存在（dev 用的是 electron.exe 在 node_modules）
   - app.isPackaged === false → tier 2: <project_root>/config.jsonc 命中
6. fs.readFileSync + jsonc-parser.parse + validateConfig → 通过
7. console.log: [config] ✓ 已加载 ...
8. const config = { targetUrl: ..., width: 1180, ... }
9. app.whenReady().then(() => createMainWindow(config))
10. BrowserWindow 使用 config.width, config.minWidth 等
```

**打包后启动成功**

```
1. 用户双击 算粒AI助手.app（或 .exe）
2. main.js 顶层: const config = await loadConfig()
3. resolveConfigPath():
   - darwin: <Contents>/Resources/config.jsonc 命中（mac.extraResources 产物）
4. parse + validate → 通过
5. 正常启动 BrowserWindow
```

**配置缺失硬失败**

```
1. 启动
2. resolveConfigPath(): 两级都找不到（exe-dir 不存在 + dev cwd 不存在）
3. console.error:
   [config] ✗ 未找到 config.jsonc
   [config]   已尝试:
   [config]     - <Contents>/config.jsonc
   [config]     - <project_root>/config.jsonc
   [config]   提示: 从仓库根或安装包复制 config.jsonc 到上述任一路径
4. process.exit(1)
```

### 8. 错误处理

| 场景 | 处理 |
|------|------|
| 两级路径都找不到 config.jsonc | 打印所有尝试路径 + 复制提示，`exit 1` |
| JSONC 语法错误 | 抛 `ConfigParseError`，含 `jsonc-parser` 行号，`exit 1` |
| 字段缺失 | 抛 `ConfigValidationError("字段 X 缺失")`，`exit 1` |
| 字段类型/范围错误 | 抛 `ConfigValidationError("字段 X 原因")`，`exit 1` |
| `targetUrl` 不是 http(s) | 抛 `ConfigValidationError("targetUrl 必须是合法的 http(s) URL")` |
| macOS `/Applications/` 用户尝试编辑 `Contents/Resources/config.jsonc` | 系统权限错误；用户应接受默认值或迁移应用到可写目录 |

## 范围

本设计**不**包含：

- ❌ 单元测试（项目当前无测试基建）
- ❌ GUI 配置编辑器
- ❌ 多 profile / 多配置文件切换
- ❌ 环境变量覆盖
- ❌ 配置变更通知 / 热重载
- ❌ 配置导入/导出 UI
- ❌ Schema 文档自动生成
- ❌ 兼容 `file://` 协议（仅 http/https）
- ❌ macOS `/Applications/` 写权限解决方案（用户接受默认或迁移应用到可写目录）

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 顶层 `await` 在某些 Node 版本失败 | 应用启动崩溃 | esbuild 显式 `topLevelAwait: true`；构建后验证 `dist-electron/main.js` 顶层 `await` 已转 `Promise.resolve().then(...)` |
| `extraResources` 在未来 electron-builder 版本改变 macOS 落地路径 | macOS 路径失效 | 路径解析代码集中在 `resolveConfigPath()`，未来只需改一处 |
| macOS `/Applications/` 用户无法编辑配置 | 用户只能接受默认 | README 文档说明：迁移应用到可写目录或接受默认 |
| `jsonc-parser` 维护中断 | 未来安全/兼容风险 | 微软官方维护；接口稳定；可替换为 `vscode-jsonc` 或自写 |
| `validateConfig` 误把合法值当错误 | 应用无法启动 | 错误信息含「实际值」便于排查；启动期快速反馈 |
| 配置文件被用户改成非法格式 | 应用无法启动 | 硬失败策略，错误信息含行号，便于修复 |
| `app.getPath('userData')` 在 `whenReady` 前调用报错 | 不适用（本设计不含 userData tier）| N/A |
| Windows NSIS `perMachine:true` 部署到 `Program Files` | 用户不可写 | 当前配置 `perMachine: false`；未来如改 true 需重新评估 |
| `extraResources` 把 `config.jsonc` 当 asar 资源打进 `.app` | macOS 编辑权限问题 | electron-builder 行为：extraResources 不进 asar，留在文件系统 |

## 验收标准

1. **dev 启动**：仓库根有 `config.jsonc`，`npm run dev:electron` 启动成功；终端日志显示 `[config] ✓ 已加载`；主窗口尺寸 1180x820（minWidth 900）
2. **dev 缺配置**：`mv config.jsonc config.jsonc.bak` 后启动 → 终端报错，exit 1
3. **dev 改字段**：把 `width` 改为 800 重启 → 主窗口 800 宽
4. **dev 改 targetUrl**：把 `targetUrl` 改为 `http://localhost:9999/` 重启 → contentView 加载 9999；访问 9998 时 `will-navigate` 拦截
5. **dev 改重试参数**：把 `maxRetries: 1, retryDelayMs: 1000` 重启 + 离线 → retryView 显示「正在重试 1/1…」
6. **dev 字段类型错**：把 `maxRetries: "三"` → 启动失败 + 提示类型错
7. **dev 字段范围错**：把 `width: 800, minWidth: 900` → 启动失败 + 提示 `width 必须 >= minWidth`
8. **JSONC 注释**：在 `config.jsonc` 顶部加 `// test comment` → 正常加载
9. **JSONC 尾逗号**：最后一个字段后加 `,` → 正常加载
10. **Windows 打包**：`npm run build:win` → release 出现 `.exe`；安装后 `%LOCALAPPDATA%\Programs\算粒AI助手\config.jsonc` 存在
11. **Windows 免安装**：`npm run build:win:zip` → `<exe-dir>/config.jsonc` 存在
12. **macOS 打包**：`npm run build:mac` → release 出现 `.dmg`；挂载后 `<productFilename>.app/Contents/Resources/config.jsonc` 存在；codesign 签名通过
13. **macOS Finder 可见**：在 Finder 中「显示包内容」`.app` 后，`Contents/Resources/config.jsonc` 可见可读（即使 root-owned 不可写）
14. **热重载不生效**：启动后修改 `config.jsonc` → 不生效；必须重启

## 后续可选（不在本次范围）

- 引入 `vitest` + `electron/config.test.ts` 单元测试
- 应用内「编辑配置」按钮：自动打开 `userData/config.jsonc` 覆盖路径（需先实现 userData 优先的 3 级 fallback）
- 环境变量覆盖（`MACAPP_TARGET_URL` 等）
- 多 profile 切换（开发 / 生产 / 自定义）
- 配置迁移工具（schema 版本演进）
- 首次启动向导，引导非技术用户编辑 `config.jsonc`
- macOS `/Applications/` 写权限解决方案（userData 优先 + 应用内编辑入口）

## 决策记录

| 决策 | 选择 | 否决项 |
|------|------|--------|
| 文件位置 | exe-dir（打包）/ cwd（dev），2 级 fallback | userData 兜底；仓库根 only |
| 格式 | JSONC | 严格 JSON；YAML；JS/TS |
| 缺失/无效行为 | 硬失败（exit 1） | 静默默认值；错误页 |
| 文件名 | `config.jsonc`（统一） | `config.json` / `app.config.json` |
| 热重载 | 不支持 | watch + 动态加载 |
| 仓库模板 | `config.jsonc` 唯一文件（既是模板也是默认值） | `config.example.json` + gitignore `config.json` |
| 协议支持 | 仅 http/https | 包含 file:// |
| 拷贝机制 | electron-builder `mac.extraResources` + `win.extraFiles` | `afterPack` / `asarUnpack` |
| JSONC 解析 | `jsonc-parser`（微软，零依赖） | 自写剥离器；`json5` |
| 测试 | 不引入测试框架 | vitest；jest |