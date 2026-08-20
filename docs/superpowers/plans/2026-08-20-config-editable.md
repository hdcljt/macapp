# config.jsonc 用户可编辑 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 把 `config.jsonc` 从「安装目录/bundle 内只读」改为「bundled default + 首次启动复制到 userData」模型，让 macOS 和 Windows 用户都能自由编辑配置文件。

**Architecture:** 保留 `package.json` 中的 `extraResources`（macOS codesign 兼容要求 bundled 在 `Contents/Resources/`），删除 `extraFiles`（冗余）；`electron/config.ts` 重写 `resolveConfigPath()` 为 async，生产模式 userData 优先 + 首次启动从 bundled 复制 + 复制失败降级读 bundled；`electron/main.ts` 把 `createMainWindow()` 改为接收 `config` 参数，`app.whenReady()` 改为 async + `await loadConfig()`。

**Tech Stack:** TypeScript 7、esbuild 0.28、electron 43、electron-builder 26

**关于测试:** 项目当前无测试框架（package.json 无 jest/vitest）；用户明确**不引入 Vitest**。本计划用「手动验证 + 频繁 commit」替代单元测试，每个任务都附带验证步骤。

---

## 文件结构

**修改文件**

| 路径 | 修改内容 |
|------|---------|
| `electron/config.ts` | 新增 `getBundledConfigPath()`；`resolveConfigPath()` 改 async + userData 优先 + 首次复制；`loadConfig()` 改 async |
| `electron/main.ts` | 删除顶层 `loadConfig()`；`createMainWindow(config)` 接收参数；`app.whenReady()` async + await loadConfig |
| `package.json` | 删除 `extraFiles` 块（保留 `extraResources`） |
| `README.md` | 重写「配置文件」章节，路径改为 userData |

**新增文件**：无

---

## Task 1: config.ts — 新增 `getBundledConfigPath()`

**Files:**
- Modify: `electron/config.ts:65-78`

- [ ] **Step 1: 在 `getExecDirConfigPath()` 之后新增 `getBundledConfigPath()`**

打开 `electron/config.ts`，找到 `getExecDirConfigPath()` 函数（[electron/config.ts:71-77](electron/config.ts#L71-L77)），在它**之后**插入：

```ts
/**
 * 解析平台特定的 bundled default 路径
 * macOS:   <exec>/../Resources/config.jsonc（extraResources 落地位置，codesign 兼容）
 * Windows: <exec-dir>/resources/config.jsonc（extraResources 落地位置）
 */
function getBundledConfigPath(): string {
  const execDir = path.dirname(process.execPath);
  if (process.platform === 'darwin') {
    return path.join(execDir, '..', 'Resources', 'config.jsonc');
  }
  return path.join(execDir, 'resources', 'config.jsonc');
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npm run build:electron`
Expected: 输出 `✅ Electron 编译完成`，无错误。esbuild 不会做严格类型检查但能发现语法错误；新增函数暂时未被调用，不影响运行时。

- [ ] **Step 3: Commit**

```bash
git add electron/config.ts
git commit -m "【需求/缺陷描述】: config.ts 新增 getBundledConfigPath

【需求/缺陷单号】: 无

【修改内容】:
- 新增 getBundledConfigPath() 函数
- macOS 返回 <.app>/Contents/Resources/config.jsonc（extraResources 落地 + codesign 兼容）
- Windows 返回 <install-dir>/resources/config.jsonc（extraResources 落地）
- 现有 getExecDirConfigPath() 保持不变（后续 Task 2 会替换其调用）"
```

---

## Task 2: config.ts — 重写 `resolveConfigPath()` 为 async + 加入 userData 优先逻辑

**Files:**
- Modify: `electron/config.ts:82-103`（替换 `resolveConfigPath()` 整个函数体）

- [ ] **Step 1: 替换 `resolveConfigPath()` 函数体**

打开 `electron/config.ts`，找到 `resolveConfigPath()` 函数（[electron/config.ts:82-103](electron/config.ts#L82-L103)），**整个函数体**替换为：

```ts
/**
 * 解析 config.jsonc 实际路径
 * - dev 模式（app.isPackaged === false）：cwd/config.jsonc（保持现状）
 * - 生产模式：
 *   1) userData/config.jsonc 存在 → 用它（用户编辑生效）
 *   2) 不存在 → 从 bundled default 复制到 userData
 *   3) 复制失败（权限/磁盘） → 降级读 bundled（编辑不持久化但能跑）
 *   4) bundled 也缺失 → 抛 ConfigNotFoundError
 */
export async function resolveConfigPath(): Promise<string> {
  // dev 模式：cwd 行为保持现状
  if (!app.isPackaged) {
    const devPath = path.join(process.cwd(), 'config.jsonc');
    if (fs.existsSync(devPath)) {
      return devPath;
    }
    throw new ConfigNotFoundError([devPath], devPath);
  }

  // 生产模式：userData 优先
  const userConfigPath = path.join(app.getPath('userData'), 'config.jsonc');

  if (fs.existsSync(userConfigPath)) {
    return userConfigPath;
  }

  // userData 没有 → 从 bundled 复制
  const bundledPath = getBundledConfigPath();

  if (!fs.existsSync(bundledPath)) {
    throw new ConfigNotFoundError(
      [userConfigPath, bundledPath],
      userConfigPath,
    );
  }

  try {
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.copyFileSync(bundledPath, userConfigPath);
    console.log(`[config] ✓ 已初始化用户配置: ${userConfigPath}`);
    return userConfigPath;
  } catch (err) {
    // 复制失败（权限/磁盘/只读卷）→ 降级读 bundled
    console.warn(
      `[config] ⚠ 无法写入 userData: ${(err as Error).message}`,
    );
    console.warn(
      `[config]   回退到 bundled default（用户编辑不会持久化）: ${bundledPath}`,
    );
    return bundledPath;
  }
}
```

注意：

- 函数签名从 `(): string` 改为 `(): Promise<string>`
- `getExecDirConfigPath()` 不再被任何代码调用（保留以备参考，但当前 spec 不删除）
- `ConfigNotFoundError` 构造函数签名不变（`(triedPaths, configPath)`）

- [ ] **Step 2: 验证编译**

Run: `npm run build:electron`
Expected: 编译成功（注意此时 `main.ts` 还在调用旧版同步 `loadConfig()`，所以 esbuild 会输出 TypeScript 错误 `Property 'then' does not exist on type 'LoadedConfig'` 或类似 — 这是预期的，下个 Task 会修）

如果想现在就让代码可编译，临时把 main.ts 的 `const config = loadConfig();` 注释掉再编译，验证完恢复。

- [ ] **Step 3: Commit**

```bash
git add electron/config.ts
git commit -m "【需求/缺陷描述】: resolveConfigPath 改为 async + userData 优先

【需求/缺陷单号】: 无

【修改内容】:
- resolveConfigPath() 签名改为 Promise<string>
- 生产模式：userData 优先，缺失时从 bundled 自动复制
- 复制失败（EACCES/磁盘满）降级读 bundled + console.warn
- bundled 缺失抛 ConfigNotFoundError（exit 1）
- dev 模式保持 cwd 行为不变
- main.ts 当前会编译失败（仍在调用旧 sync loadConfig），Task 3 修复"
```

---

## Task 3: config.ts — `loadConfig()` 改 async

**Files:**
- Modify: `electron/config.ts:196-258`

- [ ] **Step 1: 修改 `loadConfig()` 签名和第一行**

打开 `electron/config.ts`，找到 `loadConfig()` 函数（[electron/config.ts:196-258](electron/config.ts#L196-L258)），做两处改动：

1. 函数签名改为 async：

```diff
-export function loadConfig(): LoadedConfig {
+export async function loadConfig(): Promise<LoadedConfig> {
```

2. 函数体内第一行 resolveConfigPath 调用前加 await：

```diff
   let configPath: string;
   try {
-    configPath = resolveConfigPath();
+    configPath = await resolveConfigPath();
   } catch (err) {
```

其余函数体（readFileSync、parse、validateConfig、console.log）保持不变。

- [ ] **Step 2: 验证编译（临时方案）**

Run: `npm run build:electron`
Expected: 编译仍然失败，因为 main.ts 还在调用旧版同步 loadConfig（Task 4 修复）

- [ ] **Step 3: Commit**

```bash
git add electron/config.ts
git commit -m "【需求/缺陷描述】: loadConfig 改为 async

【需求/缺陷单号】: 无

【修改内容】:
- loadConfig() 签名从 LoadedConfig 改为 Promise<LoadedConfig>
- 函数体内 resolveConfigPath() 调用加 await
- 错误处理保持现状（解析/校验失败 process.exit(1)）
- main.ts 仍在调用旧 sync 版本，Task 4 修复"
```

---

## Task 4: main.ts — async loadConfig 集成

**Files:**
- Modify: `electron/main.ts:7-16`（imports + 顶层常量）
- Modify: `electron/main.ts:70-191`（createMainWindow 签名 + 函数体内常量提取）
- Modify: `electron/main.ts:193-201`（app.whenReady async）

- [ ] **Step 1: 添加 LoadedConfig 类型 import**

打开 `electron/main.ts`，在 [main.ts:7](electron/main.ts#L7) 的 `import { loadConfig } from './config';` 之后新增：

```ts
import type { LoadedConfig } from './config';
```

- [ ] **Step 2: 删除顶层常量（[main.ts:9-16](electron/main.ts#L9-L16)）**

删除下面 8 行：

```ts
// loadConfig() 同步函数（失败由 config.ts 内部 process.exit(1)），无需 await
// 不能用 await 顶层调用：esbuild 0.28 + format:cjs 拒绝顶层 await（即使包 async IIFE）
const config = loadConfig();
const isDev = !app.isPackaged;
const TARGET_URL = config.targetUrl;
const MAX_RETRIES = config.maxRetries;
const RETRY_DELAY_MS = config.retryDelayMs;
const ALLOWED_ORIGIN_PREFIX = config.allowedOriginPrefix;
```

注意 [main.ts:18](electron/main.ts#L18) 的 `let mainWindow: BrowserWindow | null = null;` 等其他模块级变量**保留**。

- [ ] **Step 3: 修改 `createMainWindow()` 签名并把常量提取移到函数体内**

找到 `function createMainWindow()`（[main.ts:70](electron/main.ts#L70)），改为：

```ts
function createMainWindow(config: LoadedConfig) {
  const isDev = !app.isPackaged;
  const TARGET_URL = config.targetUrl;
  const MAX_RETRIES = config.maxRetries;
  const RETRY_DELAY_MS = config.retryDelayMs;
  const ALLOWED_ORIGIN_PREFIX = config.allowedOriginPrefix;

  mainWindow = new BrowserWindow({
```

也就是：

- 函数签名加 `config: LoadedConfig` 参数
- 函数体最前面（`mainWindow = new BrowserWindow` 之前）插入 5 行常量提取
- 函数体其余部分**完全不变**（包括 `config.width` / `config.height` / `config.minWidth` / `config.minHeight` 这些已经用 `config.X` 的写法）

- [ ] **Step 4: 修改 `app.whenReady()` 为 async**

找到 `app.whenReady().then(...)`（[main.ts:193-201](electron/main.ts#L193-L201)），替换为：

```ts
app.whenReady().then(async () => {
  const config = await loadConfig();
  createMainWindow(config);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(config);
    }
  });
});
```

也就是：

- `.then(() => {...})` → `.then(async () => {...})`
- 函数体内第一行加 `const config = await loadConfig();`
- 两处 `createMainWindow()` 调用改为 `createMainWindow(config)`

- [ ] **Step 5: 验证编译**

Run: `npm run build:electron`
Expected: `✅ Electron 编译完成`，无错误。

如果编译失败：

- 检查 `createMainWindow` 函数体内是否所有 `TARGET_URL` / `MAX_RETRIES` 等引用还在（函数体内 5 个常量提取应满足所有引用）
- 检查 `app.whenReady` 回调是否正确 await
- 检查 `createMainWindow(config)` 调用是否都传了 config

- [ ] **Step 6: dev 模式冒烟测试**

Run: `npm run dev:electron`
Expected:

- 终端打印 `[config] ✓ 已加载 <仓库根>/config.jsonc`
- 终端打印 `[config]   targetUrl: http://localhost:5195/agent-user/assistant`
- 终端打印 `[config]   窗口: 1180x820 (min 900x700)`
- 终端打印 `[config]   重试: 3 次, 间隔 5000ms`
- Electron 窗口正常打开（如果 5195 端口有后端则加载网页，否则进入重试流程）
- 关闭窗口，进程退出

按 Ctrl+C 退出。

- [ ] **Step 7: Commit**

```bash
git add electron/main.ts
git commit -m "【需求/缺陷描述】: main.ts 集成 async loadConfig

【需求/缺陷单号】: 无

【修改内容】:
- 新增 import type { LoadedConfig } from './config'
- 删除顶层 loadConfig() 调用和派生常量（5 个 const）
- createMainWindow(config: LoadedConfig) 接收参数
- 函数体内提取 isDev / TARGET_URL / MAX_RETRIES / RETRY_DELAY_MS / ALLOWED_ORIGIN_PREFIX
- app.whenReady() 改 async，await loadConfig() 后传给 createMainWindow
- app.on('activate') 内的 createMainWindow 也传 config
- dev 模式冒烟通过（npm run dev:electron 正常加载配置）"
```

---

## Task 5: package.json — 删除 `extraFiles` 块

**Files:**
- Modify: `package.json:38-53`

- [ ] **Step 1: 删除 `extraFiles` 块**

打开 `package.json`，找到 `build` 字段（[package.json:30-145](package.json#L30-L145)），**删除整个 `extraFiles` 块**（6 行）：

```diff
     "extraResources": [
       {
         "from": "config.jsonc",
         "to": "config.jsonc"
       }
     ],
-    "extraFiles": [
-      {
-        "from": "config.jsonc",
-        "to": "config.jsonc"
-      }
-    ],
     "mac": {
```

注意：

- `extraResources` 块**完整保留**（macOS codesign 要求）
- `extraFiles` 之后紧接着的 `"mac": {` 等其他字段位置不变

- [ ] **Step 2: 验证 package.json 仍然合法 JSON**

Run:

```bash
node -e "console.log(JSON.stringify(require('./package.json').build, null, 2))" | head -30
```

Expected: 输出 build 字段的格式化 JSON，包含 `extraResources` 但不包含 `extraFiles`

- [ ] **Step 3: 验证 Windows 构建产物结构（可选，需要 electron-builder 环境）**

Run: `npm run build:win:zip`
Expected: 在 `release/{version}/` 下产出 zip，解压后结构：

- `<App>.exe`（executable）
- `app.asar`
- `resources/config.jsonc`（来自 extraResources，仅作 bundled default）
- **不包含**根目录的 `config.jsonc`（之前来自 extraFiles）

如果当前在 macOS 环境无法跑 Windows 构建，跳过此步，等合并后由 CI 验证。

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "【需求/缺陷描述】: 删除冗余的 extraFiles 配置

【需求/缺陷单号】: 无

【修改内容】:
- 保留 extraResources（macOS codesign 要求在 Contents/Resources/）
- 删除 extraFiles 块（Windows 上冗余，代码改为读 userData 不再需要 exe 同级副本）
- Windows 构建产物结构：根目录不再有 config.jsonc，resources/config.jsonc 仍存在"
```

---

## Task 6: README.md — 更新「配置文件」章节

**Files:**
- Modify: `README.md:123-184`

- [ ] **Step 1: 替换整个「配置文件」章节**

打开 `README.md`，找到「## ⚙️ 配置文件」标题（[README.md:123](README.md#L123)），一直替换到「## 🌐 跨平台开发流程」标题（[README.md:186](README.md#L186)）之前的所有内容。

整个章节替换为：

````markdown
## ⚙️ 配置文件

应用通过 `config.jsonc` 实现行为配置。该文件**首次启动时自动生成**在用户可编辑的位置：

- **macOS**: `~/Library/Application Support/算粒AI助手/config.jsonc`
- **Windows**: `%APPDATA%\算粒AI助手\config.jsonc`

应用包内（不可编辑的位置）保留一份「出厂默认」配置，作为首次启动的种子：

- **macOS**: `<productFilename>.app/Contents/Resources/config.jsonc`
  - 落地于 `Contents/Resources/` 而非 `Contents/` 是 macOS bundle 规范要求：codesign 拒绝签名 `Contents/` 根目录的非代码文件，会报 `code object is not signed at all`。
- **Windows**: `<install-dir>/resources/config.jsonc`

### 字段说明

| 字段 | 类型 | 含义 |
|------|------|------|
| `targetUrl` | string | 启动后 contentView 加载的 URL，仅接受以 `http://` 或 `https://` 开头的合法 URL 语法 |
| `maxRetries` | integer ≥ 0 | URL 加载失败时的最大重试次数（`0` 表示不重试，直接进入错误页） |
| `retryDelayMs` | integer ≥ 0 | 每次重试间隔毫秒数 |
| `width` | integer ≥ 1 且 ≥ `minWidth` | BrowserWindow 初始宽度（像素） |
| `height` | integer ≥ 1 且 ≥ `minHeight` | BrowserWindow 初始高度（像素） |
| `minWidth` | integer ≥ 1 | BrowserWindow 最小宽度（像素） |
| `minHeight` | integer ≥ 1 | BrowserWindow 最小高度（像素） |

### 格式

`config.jsonc` 是 JSONC 格式（支持 `//` 单行注释、`/* */` 块注释、尾随逗号），示例：

```jsonc
{
  // 目标 URL：启动后加载该地址
  "targetUrl": "http://localhost:5195/agent-user/assistant",
  // 加载失败时最多重试 3 次
  "maxRetries": 3,
  // 每次重试间隔 5 秒
  "retryDelayMs": 5000,
  // 窗口尺寸
  "width": 1180,
  "height": 820,
  "minWidth": 900,
  "minHeight": 700
}
```

### 加载规则

启动时按以下顺序查找：

1. **dev 模式**（`npm run dev`）：仓库根 `config.jsonc`
2. **生产模式**：用户目录的 `config.jsonc`（路径见章节开头）
3. 若用户目录配置不存在 → 从应用包内的出厂默认自动复制过去
4. 若复制失败（权限/磁盘满）→ 降级使用包内默认（用户编辑不持久化但能跑）

错误处理：

- **读取失败 / JSONC 解析失败 / 字段缺失或类型错误**：启动失败（exit 1）并打印具体错误
- **修改后**：重启应用生效（不热重载）

### 恢复出厂默认

删除用户目录下的 `config.jsonc`，下次启动时会自动从应用包内的默认配置重新生成。

### 自定义部署（运维）

批量部署时如需预设统一配置，改应用包内的出厂默认后重新打包：

- macOS: `<.app>/Contents/Resources/config.jsonc`
- Windows: `<install-dir>/resources/config.jsonc`

用户目录下的副本**永远优先**于包内默认。即使用户已经启动过一次应用生成了 userData 副本，运维改包内默认不会影响已经运行过的用户。

### 仓库构建

构建时 `electron-builder` 通过 `extraResources` 把仓库根 `config.jsonc` 打包进应用：

- macOS: `<.app>/Contents/Resources/config.jsonc`（codesign 安全位置）
- Windows: `<install-dir>/resources/config.jsonc`

若修改了仓库根 `config.jsonc`，需要重新执行 `npm run build` 并重新安装应用。

开发模式（`npm run dev`）下直接读取仓库根 `config.jsonc`。
````

- [ ] **Step 2: 检查 Markdown 渲染**

Run: 在编辑器中打开 README.md 滚动到「配置文件」章节，肉眼检查：

- 4 个 ## ### 子标题层级正确
- 表格对齐正确
- 代码块 ```jsonc 标签正确
- 「恢复出厂默认」/「自定义部署」/「仓库构建」3 个三级子章节完整

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "【需求/缺陷描述】: README 更新配置文件位置文档

【需求/缺陷单号】: 无

【修改内容】:
- 「配置文件」章节路径改为 userData（macOS / Windows 标准位置）
- 新增「恢复出厂默认」「自定义部署」子章节
- 「加载规则」增加 userData 优先 + 首次复制 + 降级 bundled 描述
- 「仓库构建」说明改为只走 extraResources（删除 extraFiles 描述）"
```

---

## Task 7: 端到端验证

**Files:** 无（纯验证步骤）

- [ ] **Step 1: dev 模式完整验证**

Run: `npm run dev:electron`

逐项验证（对照 [docs/superpowers/specs/2026-08-20-config-editable-design.md](docs/superpowers/specs/2026-08-20-config-editable-design.md) 验收标准 1-3）：

- [ ] 终端打印 `[config] ✓ 已加载 <仓库根>/config.jsonc` 路径
- [ ] 终端打印 4 行配置详情（targetUrl、窗口、重试）
- [ ] Electron 窗口打开（如果 5195 端口可达则加载网页，否则进入 splash 转圈 → retry）
- [ ] 关闭窗口，进程正常退出

- [ ] **Step 2: dev 模式缺配置验证**

```bash
mv config.jsonc /tmp/config.jsonc.bak  # 或任意位置备份
npm run dev:electron
```

Expected:

- 终端打印 `[config] ✗ 未找到 config.jsonc`
- 终端列出尝试的路径
- 进程 exit 1
- Electron 窗口不出现

恢复：

```bash
mv /tmp/config.jsonc.bak config.jsonc
```

- [ ] **Step 3: dev 模式字段修改验证**

编辑 `config.jsonc` 把 `width` 改为 `1000`，保存，重启 `npm run dev:electron`。
Expected: 终端打印 `[config]   窗口: 1000x820 (min 900x700)`，窗口宽度变成 1000。

改回 1180。

- [ ] **Step 4: Windows 打包验证（如果环境允许）**

如果当前在 Windows 机器：

```bash
npm run build:win:nsis
```

Expected: `release/{version}/` 下产出 NSIS installer。

检查解压后 `win-unpacked/` 结构：

```bash
ls release/{version}/win-unpacked/
ls release/{version}/win-unpacked/resources/
```

- 根目录有 `算粒AI助手.exe`、`app.asar`
- **根目录不应有** `config.jsonc`（之前来自 extraFiles，已删除）
- `resources/config.jsonc` 存在（来自 extraResources，bundled default）

如不在 Windows 机器，记录此步为「由 CI 验证」，跳到 Step 5。

- [ ] **Step 5: macOS 打包产物验证（由 CI 验证）**

macOS 打包需要 macOS 机器，不在本地验证。提交后由 GitHub Actions runner 构建后人工检查 `.app` 包内容：

- `<.app>/Contents/Resources/config.jsonc` 存在（bundled default）
- **不验证** userData 是否生成（需要实际运行 Electron，CI runner 是无 GUI 的）

- [ ] **Step 6: 总结验证结果**

如果所有验证通过 → Task 7 完成，spec 实施完毕。
如果有验证失败 → 回到对应 Task 排查，记录到 commit message 或单独的 issue。

---

## 自审

**Spec 覆盖检查**：

| Spec 验收标准 | 覆盖任务 |
|--------------|---------|
| 1-3 (dev 模式 3 条) | Task 4 Step 6 + Task 7 Steps 1-3 |
| 4-10 (Windows 7 条) | Task 5（构建）+ Task 7 Step 4（如果 Windows 环境） |
| 11-15 (macOS 5 条) | Task 7 Step 5（CI 验证） |
| 16-17 (文档 2 条) | Task 6（README 更新） |

**占位符扫描**：✅ 无 TBD/TODO/略；所有 Step 含实际代码或命令

**类型一致性**：

- `LoadedConfig` 在 config.ts 导出（保持原状）
- main.ts 通过 `import type` 引用
- `resolveConfigPath(): Promise<string>` 在 Task 2 定义，Task 3 在 loadConfig 中用 await，Task 4 在 main.ts 间接 await
- `getBundledConfigPath(): string` 在 Task 1 定义，Task 2 在 resolveConfigPath 内调用
- `createMainWindow(config: LoadedConfig)` 在 Task 4 定义并使用

**潜在风险**：

- Task 2/3 完成后 main.ts 暂时编译失败（直到 Task 4）— 已记录在 Step 2 注释
- Task 5 不验证实际 Windows 构建（环境限制）— Task 7 Step 4 由 CI 兜底

---

## 执行检查清单

完成后逐项打勾：

- [ ] Task 1: config.ts — `getBundledConfigPath()` ✅
- [ ] Task 2: config.ts — `resolveConfigPath()` async + userData 优先 ✅
- [ ] Task 3: config.ts — `loadConfig()` async ✅
- [ ] Task 4: main.ts — async loadConfig 集成 + dev 冒烟通过 ✅
- [ ] Task 5: package.json — 删除 `extraFiles` 块 ✅
- [ ] Task 6: README.md — 更新「配置文件」章节 ✅
- [ ] Task 7: 端到端验证全部通过（或 CI 验证记录在案）✅