# Electron 应用外置 JSONC 配置 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标:** 将 `electron/main.ts` 硬编码的 7 个常量抽离到 `config.jsonc`，应用启动时按平台特定路径读取；缺失或字段错误硬失败。

**Architecture:** 新增 `electron/config.ts` 集中负责路径解析、JSONC 解析、字段校验与失败退出；`main.ts` 顶层 `await loadConfig()` 消费 `config.*`；electron-builder `mac.extraResources` + `win.extraFiles` 分平台把仓库根 `config.jsonc` 拷贝到目标位置。

**Tech Stack:** TypeScript 7、esbuild 0.28、electron-builder 26、`jsonc-parser` 3.3（新增）

**关于测试:** 项目当前无测试框架（package.json 无 jest/vitest）；本计划用「手动验证 + 频繁 commit」替代单元测试，每个任务都附带验证步骤。

---

## 文件结构

**新增文件**

| 路径 | 职责 |
|------|------|
| `config.jsonc` | 仓库根，git 跟踪；定义 7 个配置字段含注释 |
| `electron/config.ts` | 路径解析 + JSONC 解析 + 字段校验 + 失败退出 |

**修改文件**

| 路径 | 修改内容 |
|------|---------|
| `electron/main.ts` | 顶部 `await loadConfig()`；删除 7 个硬编码常量；用 `config.*` 替换 |
| `scripts/build-electron.js` | esbuild 配置加 `topLevelAwait: true` |
| `package.json` | devDependencies 加 `jsonc-parser`；build 加 `mac.extraResources` + `win.extraFiles` |
| `.gitignore` | 忽略打包输出内的 `config.jsonc` |
| `README.md` | 新增「配置文件」章节 |

---

## Task 1: 添加 `config.jsonc` 到仓库根

**Files:**
- Create: `config.jsonc`

- [ ] **Step 1: 创建 `config.jsonc` 文件**

在仓库根 `d:\hudc\git\gitlab\pc\macapp\config.jsonc` 写入：

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

- [ ] **Step 2: 验证文件**

Run: `cat config.jsonc` (Bash) 或在编辑器中打开
Expected: 7 个字段齐全，注释保留

- [ ] **Step 3: Commit**

```bash
git add config.jsonc
git commit -m "feat(config): 添加仓库根 config.jsonc 默认配置

包含 targetUrl/maxRetries/retryDelayMs/width/height/minWidth/minHeight
七个字段，每个字段含 // 注释说明。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 添加 `jsonc-parser` 依赖

**Files:**
- Modify: `package.json` (devDependencies)

- [ ] **Step 1: 添加依赖到 package.json**

编辑 `package.json` 的 `devDependencies` 块，在 `esbuild` 之后插入：

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
   }
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: 提示 `added 1 package`，无 ERR；`node_modules/jsonc-parser/` 出现

- [ ] **Step 3: 验证包可加载**

Run: `node -e "const p = require('jsonc-parser'); console.log(typeof p.parse)"`
Expected: `function`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(deps): 添加 jsonc-parser 依赖

用于解析 config.jsonc（支持 // 注释与尾逗号），微软官方维护，零运行时依赖。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 创建 `electron/config.ts`

**Files:**
- Create: `electron/config.ts`

- [ ] **Step 1: 编写 `electron/config.ts`**

在 `d:\hudc\git\gitlab\pc\macapp\electron\config.ts` 写入完整文件：

```ts
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, ParseError } from 'jsonc-parser';

/**
 * 应用配置 schema（7 字段，全部必填）
 */
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

/**
 * 已加载配置（含派生字段）
 */
export interface LoadedConfig extends AppConfig {
  /** 由 targetUrl 推导，供 will-navigate 使用 */
  allowedOriginPrefix: string;
}

/** 配置错误基类 */
export class ConfigError extends Error {
  constructor(message: string, readonly configPath: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** JSONC 解析错误 */
export class ConfigParseError extends ConfigError {
  constructor(message: string, configPath: string) {
    super(message, configPath);
    this.name = 'ConfigParseError';
  }
}

/** 字段校验错误 */
export class ConfigValidationError extends ConfigError {
  constructor(message: string, configPath: string) {
    super(message, configPath);
    this.name = 'ConfigValidationError';
  }
}

/** 配置文件不存在错误 */
export class ConfigNotFoundError extends ConfigError {
  constructor(readonly triedPaths: string[], configPath: string) {
    super(`未找到 config.jsonc`, configPath);
    this.name = 'ConfigNotFoundError';
  }
}

/**
 * 解析平台特定的 exe-dir 配置路径
 * macOS: <exec>/../Resources/config.jsonc（mac.extraResources 落地位置）
 *   注意：必须放在 Contents/Resources/，否则 codesign 拒绝签名 Contents/ 根目录的非代码文件
 * 其他:  <exec-dir>/config.jsonc（win.extraFiles 落地位置）
 */
function getExecDirConfigPath(): string {
  const execDir = path.dirname(process.execPath);
  if (process.platform === 'darwin') {
    return path.join(execDir, '..', 'config.jsonc');
  }
  return path.join(execDir, 'config.jsonc');
}

/**
 * 解析 config.jsonc 实际路径（2 级 fallback）
 */
export function resolveConfigPath(): string {
  const triedPaths: string[] = [];

  // Tier 1: 平台特定 exe-dir 路径
  const tier1 = getExecDirConfigPath();
  triedPaths.push(tier1);
  if (fs.existsSync(tier1)) {
    return tier1;
  }

  // Tier 2: dev 模式 fallback（cwd）
  if (!app.isPackaged) {
    const tier2 = path.join(process.cwd(), 'config.jsonc');
    triedPaths.push(tier2);
    if (fs.existsSync(tier2)) {
      return tier2;
    }
  }

  // 都未命中：构造错误信息
  throw new ConfigNotFoundError(triedPaths, tier1);
}

/**
 * 校验配置对象的 7 个字段（缺失 / 类型 / 范围）
 */
function validateConfig(obj: unknown, configPath: string): AppConfig {
  if (typeof obj !== 'object' || obj === null) {
    throw new ConfigValidationError('config.jsonc 必须是 JSON 对象', configPath);
  }
  const o = obj as Record<string, unknown>;

  const errors: string[] = [];

  // targetUrl
  if (!('targetUrl' in o)) {
    errors.push('字段 targetUrl 缺失');
  } else if (typeof o.targetUrl !== 'string' || o.targetUrl.length === 0) {
    errors.push('targetUrl 必须是非空字符串');
  } else if (!/^https?:\/\//.test(o.targetUrl)) {
    errors.push(`targetUrl 必须是合法的 http(s) URL (实际: "${o.targetUrl}")`);
  } else {
    try {
      new URL(o.targetUrl);
    } catch {
      errors.push(`targetUrl 必须是合法的 URL (实际: "${o.targetUrl}")`);
    }
  }

  // maxRetries
  if (!('maxRetries' in o)) {
    errors.push('字段 maxRetries 缺失');
  } else if (!Number.isInteger(o.maxRetries) || (o.maxRetries as number) < 0) {
    errors.push(`maxRetries 必须是非负整数 (实际: ${JSON.stringify(o.maxRetries)})`);
  }

  // retryDelayMs
  if (!('retryDelayMs' in o)) {
    errors.push('字段 retryDelayMs 缺失');
  } else if (!Number.isInteger(o.retryDelayMs) || (o.retryDelayMs as number) < 0) {
    errors.push(`retryDelayMs 必须是非负整数 (实际: ${JSON.stringify(o.retryDelayMs)})`);
  }

  // minWidth, minHeight（先校验，用于 width/height 范围判断）
  const minWidth = o.minWidth;
  const minHeight = o.minHeight;
  if (!('minWidth' in o)) {
    errors.push('字段 minWidth 缺失');
  } else if (!Number.isInteger(minWidth) || (minWidth as number) < 1) {
    errors.push(`minWidth 必须是 >= 1 的整数 (实际: ${JSON.stringify(minWidth)})`);
  }
  if (!('minHeight' in o)) {
    errors.push('字段 minHeight 缺失');
  } else if (!Number.isInteger(minHeight) || (minHeight as number) < 1) {
    errors.push(`minHeight 必须是 >= 1 的整数 (实际: ${JSON.stringify(minHeight)})`);
  }

  // width
  if (!('width' in o)) {
    errors.push('字段 width 缺失');
  } else if (!Number.isInteger(o.width) || (o.width as number) < 1) {
    errors.push(`width 必须是 >= 1 的整数 (实际: ${JSON.stringify(o.width)})`);
  } else if (Number.isInteger(minWidth) && (o.width as number) < (minWidth as number)) {
    errors.push(`width (${o.width}) 必须 >= minWidth (${minWidth})`);
  }

  // height
  if (!('height' in o)) {
    errors.push('字段 height 缺失');
  } else if (!Number.isInteger(o.height) || (o.height as number) < 1) {
    errors.push(`height 必须是 >= 1 的整数 (实际: ${JSON.stringify(o.height)})`);
  } else if (Number.isInteger(minHeight) && (o.height as number) < (minHeight as number)) {
    errors.push(`height (${o.height}) 必须 >= minHeight (${minHeight})`);
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors.join('\n  - '), configPath);
  }

  return {
    targetUrl: o.targetUrl as string,
    maxRetries: o.maxRetries as number,
    retryDelayMs: o.retryDelayMs as number,
    width: o.width as number,
    height: o.height as number,
    minWidth: o.minWidth as number,
    minHeight: o.minHeight as number,
  };
}

/**
 * 加载并校验 config.jsonc
 * 失败时 console.error + process.exit(1)
 */
export function loadConfig(): LoadedConfig {
  let configPath: string;
  try {
    configPath = resolveConfigPath();
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      console.error('[config] ✗ 未找到 config.jsonc');
      console.error('[config]   已尝试:');
      for (const p of err.triedPaths) {
        console.error(`[config]     - ${p}`);
      }
      console.error('[config]   提示: 从仓库根或安装包复制 config.jsonc 到上述任一路径');
      process.exit(1);
    }
    throw err;
  }

  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    console.error(`[config] ✗ 读取失败: ${configPath}`);
    console.error(`[config]   ${(err as Error).message}`);
    process.exit(1);
  }

  const parseErrors: ParseError[] = [];
  const data = parse(text, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length > 0) {
    const e = parseErrors[0];
    console.error(`[config] ✗ JSONC 解析失败: ${configPath}`);
    console.error(`[config]   第 ${e.offset + 1} 字符附近: ${e.error}`);
    process.exit(1);
  }

  let validated: AppConfig;
  try {
    validated = validateConfig(data, configPath);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(`[config] ✗ 字段校验失败: ${configPath}`);
      console.error(`[config]   - ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // 派生 allowedOriginPrefix
  let allowedOriginPrefix: string;
  try {
    allowedOriginPrefix = new URL(validated.targetUrl).origin + '/';
  } catch {
    console.error(`[config] ✗ targetUrl 无法解析为 URL: ${validated.targetUrl}`);
    process.exit(1);
  }

  console.log(`[config] ✓ 已加载 ${configPath}`);
  console.log(`[config]   targetUrl: ${validated.targetUrl}`);
  console.log(`[config]   窗口: ${validated.width}x${validated.height} (min ${validated.minWidth}x${validated.minHeight})`);
  console.log(`[config]   重试: ${validated.maxRetries} 次, 间隔 ${validated.retryDelayMs}ms`);

  return { ...validated, allowedOriginPrefix };
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `npx tsc --noEmit electron/config.ts`
Expected: 无错误（应该 0 errors）

如果报告找不到 `electron` 模块的错误，用：
```bash
npx tsc --noEmit --skipLibCheck --moduleResolution node --target esnext --module commonjs electron/config.ts
```
Expected: 仍应 0 errors（jsonc-parser 自带类型）

- [ ] **Step 3: Commit**

```bash
git add electron/config.ts
git commit -m "feat(config): 新增 electron/config.ts 负责配置加载与校验

- 路径解析：macOS 跳一级到 Contents/，其他平台走 exec-dir
- JSONC 解析：jsonc-parser 支持注释与尾逗号
- 字段校验：7 字段全部必填，类型与范围严格
- 失败处理：console.error + process.exit(1)；错误信息含路径与字段名

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 在 `main.ts` 顶部消费 `loadConfig()`

**Files:**
- Modify: `electron/main.ts` (lines 1-10, 65-69, 148)

- [ ] **Step 1: 修改 import 与顶部常量**

在 `electron/main.ts` 顶部做以下替换：

```diff
 import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron';
 import path from 'node:path';

 // CJS 模式下 __dirname 是内置的；ESM 模式下需要用 import.meta.url
 declare const __dirname: string;

-const isDev = !app.isPackaged;
-const TARGET_URL = 'http://localhost:5195/agent-user/assistant';
-const MAX_RETRIES = 3;
-const RETRY_DELAY_MS = 5000;
+import { loadConfig } from './config';
+
+// 顶层 await：在 app.whenReady() 之前完成；失败由 config.ts 内部 process.exit(1)
+const config = await loadConfig();
+const isDev = !app.isPackaged;
+const TARGET_URL = config.targetUrl;
+const MAX_RETRIES = config.maxRetries;
+const RETRY_DELAY_MS = config.retryDelayMs;
+const ALLOWED_ORIGIN_PREFIX = config.allowedOriginPrefix;
```

- [ ] **Step 2: 替换 BrowserWindow 构造中的硬编码尺寸**

找到 `createMainWindow()` 中的 `new BrowserWindow({...})` 调用，替换 4 个尺寸字段：

```diff
   mainWindow = new BrowserWindow({
-    width: 1180,
-    height: 820,
-    minWidth: 900,
-    minHeight: 700,
+    width: config.width,
+    height: config.height,
+    minWidth: config.minWidth,
+    minHeight: config.minHeight,
     titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
     trafficLightPosition: { x: 16, y: 16 },
     backgroundColor: '#FFFFFF',
     show: false,
     webPreferences: {
```

- [ ] **Step 3: 替换 `will-navigate` 中的硬编码 origin**

找到 `will-navigate` 监听器（约 line 147-152）：

```diff
   // 拦截非目标 origin 的导航
   contentView.webContents.on('will-navigate', (event, url) => {
-    if (!url.startsWith('http://localhost:5195/')) {
+    if (!url.startsWith(ALLOWED_ORIGIN_PREFIX)) {
       event.preventDefault();
       console.warn(`[will-navigate blocked] ${url}`);
     }
   });
```

- [ ] **Step 4: 验证修改后文件**

Run: `cat electron/main.ts | head -25`
Expected: 看到 `import { loadConfig } from './config';` 与 `const config = await loadConfig();`

- [ ] **Step 5: 验证 TypeScript 编译**

Run: `npx tsc --noEmit electron/main.ts`
Expected: 无错误（topLevelAwait 需要 esbuild 配置变更，下一任务处理；tsc 较宽松）

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts
git commit -m "refactor(main): 消费 config.* 替换 7 个硬编码常量

- 顶部 await loadConfig()（失败 exit 1）
- BrowserWindow 尺寸由 config.width/height/minWidth/minHeight 驱动
- will-navigate 用 ALLOWED_ORIGIN_PREFIX 替代硬编码 origin

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 为 esbuild 启用 `topLevelAwait`

**Files:**
- Modify: `scripts/build-electron.js` (main.ts 构建块)

- [ ] **Step 1: 添加 `topLevelAwait: true`**

在 `scripts/build-electron.js` 中找到 `await build({...entryPoints: [path.join(root, 'electron/main.ts')],...})` 块，在 `external: ['electron']` 之后加一行：

```diff
   // 编译 main.ts
   await build({
     entryPoints: [path.join(root, 'electron/main.ts')],
     outfile: path.join(outdir, 'main.js'),
     bundle: true,
     platform: 'node',
     target: 'node18',
     format: 'cjs',
     external: ['electron'],
+    topLevelAwait: true,
     sourcemap: true,
     logLevel: 'info',
   });
```

- [ ] **Step 2: 执行构建**

Run: `node scripts/build-electron.js`
Expected: 看到 `✅ Electron 编译完成`，无 `topLevelAwait` 相关警告

- [ ] **Step 3: 验证产物**

Run: `head -20 dist-electron/main.js`
Expected: 看到 `Promise.resolve().then(...)` 或 `await __toCommonJS(...)` 包装（顶层 await 编译产物）；不应有 `SyntaxError: await is only valid in async function` 错误

- [ ] **Step 4: Commit**

```bash
git add scripts/build-electron.js
git commit -m "build(esbuild): 启用 topLevelAwait 支持 main.ts 顶层 await loadConfig()

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 配置 electron-builder 拷贝 config.jsonc

**Files:**
- Modify: `package.json` (build block)

- [ ] **Step 1: 在 `mac` 段添加 `extraResources`，在 `win` 段添加 `extraFiles`**

macOS 必须用 `extraResources`（落到 `Contents/Resources/`，避开 codesign 拒绝签名 `Contents/` 根目录非代码文件的问题）；Windows 用 `extraFiles`（落到 `<exe-dir>/config.jsonc`，与 `.exe` 同级）：

```diff
     "mac": {
+      "extraResources": [
+        {
+          "from": "config.jsonc",
+          "to": "config.jsonc"
+        }
+      ],
       "category": "public.app-category.productivity",
       ...
     },
     "win": {
       ...
       "icon": "build/icon.ico",
-      "artifactName": "${productName}-${version}-${arch}-Setup.${ext}"
+      "artifactName": "${productName}-${version}-${arch}-Setup.${ext}",
+      "extraFiles": [
+        {
+          "from": "config.jsonc",
+          "to": "config.jsonc"
+        }
+      ]
     }
```

- [ ] **Step 2: 验证 JSON 语法**

Run: `node -e "console.log(JSON.stringify(require('./package.json').build, null, 2))"`
Expected: 看到 `mac.extraResources` 与 `win.extraFiles` 数组，都包含 `from: "config.jsonc"`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build(electron-builder): 用 mac.extraResources + win.extraFiles 拷贝 config.jsonc

macOS 落地 <productFilename>.app/Contents/Resources/config.jsonc（标准资源目录，codesign 安全）
Windows 落地 <exe-dir>/config.jsonc （与 .exe 同级）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 更新 `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: 添加 ignore 行**

在 `.gitignore` 末尾追加：

```gitignore
# 打包输出内的 config.jsonc（构建产物）
release/**/config.jsonc
dist-electron/config.jsonc
```

- [ ] **Step 2: 验证 ignore**

Run: `git check-ignore -v config.jsonc` (在仓库根)
Expected: 不输出（即仓库根 config.jsonc **不**被忽略，是源文件）

Run: `git check-ignore -v release/win-unpacked/config.jsonc`
Expected: 输出忽略规则，路径包含 `release/**/config.jsonc`

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(gitignore): 忽略打包输出内的 config.jsonc

仓库根 config.jsonc 是源文件必须提交，不在 ignore 列表。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 更新 README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 添加「配置文件」章节**

在 `README.md` 中找到合适的位置（建议在「快速开始」或「项目结构」之后），插入：

```markdown
## 配置文件

应用启动时按以下顺序查找 `config.jsonc`：

1. 平台特定 exe-dir 路径
   - macOS：`<productFilename>.app/Contents/Resources/config.jsonc`
   - Windows / Linux：`<exe-dir>/config.jsonc`
2. dev 模式：`process.cwd()/config.jsonc`

字段说明见仓库根 `config.jsonc` 内的 `//` 注释。
**修改后必须重启应用**——本设计不支持热重载。

修改任意字段后必须重启 Electron 主进程才能生效。
```

- [ ] **Step 2: 验证渲染**

在编辑器中打开 `README.md`，确认新增章节格式正确（标题层级与现有文档一致）

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): 新增配置文件章节说明 config.jsonc 查找顺序

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: 验证 dev 模式启动

**Files:** 无（验证任务）

- [ ] **Step 1: 启动 dev**

Run: `npm run dev:electron`
Expected: 
- 终端出现 `[config] ✓ 已加载 d:\hudc\git\gitlab\pc\macapp\config.jsonc`
- 紧跟 `targetUrl: http://localhost:5195/agent-user/assistant`
- 紧跟 `窗口: 1180x820 (min 900x700)`
- 紧跟 `重试: 3 次, 间隔 5000ms`
- 主窗口打开

- [ ] **Step 2: 验证窗口尺寸**

观察主窗口：
Expected: 初始尺寸 1180x820；拖拽右下角缩小到 900x700 时不应继续缩小

- [ ] **Step 3: 关闭应用**

点击窗口关闭按钮或 Ctrl+C 停止 dev

---

## Task 10: 验证配置缺失硬失败

**Files:** 无（验证任务）

- [ ] **Step 1: 临时备份 config.jsonc**

Run: `mv config.jsonc config.jsonc.bak` (Bash) 或用文件管理器
Expected: 文件被重命名

- [ ] **Step 2: 启动 dev 验证失败**

Run: `npm run dev:electron`
Expected: 
- 终端出现 `[config] ✗ 未找到 config.jsonc`
- 列出 `[config]   已尝试:` 与至少两个路径
- 进程退出码为 1（仅看进程是否退出；可用 `echo $?` 或 PowerShell `echo $LASTEXITCODE`）

- [ ] **Step 3: 恢复 config.jsonc**

Run: `mv config.jsonc.bak config.jsonc`
Expected: 文件被还原

- [ ] **Step 4: 验证恢复后正常启动**

Run: `npm run dev:electron`
Expected: 正常加载 `[config] ✓ 已加载 ...`，主窗口打开

Close: Ctrl+C 停止

---

## Task 11: 验证字段校验错误信息

**Files:** 无（验证任务）

- [ ] **Step 1: 测试字段缺失**

```bash
# 备份
cp config.jsonc config.jsonc.bak
# 删字段（用 Node 一行命令）
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.jsonc','utf-8'));delete c.maxRetries;fs.writeFileSync('config.jsonc',JSON.stringify(c,null,2))"
```

Run: `npm run dev:electron`
Expected: 终端 `[config] ✗ 字段校验失败:`，`- 字段 maxRetries 缺失`；exit 1

Close: Ctrl+C

- [ ] **Step 2: 测试类型错**

```bash
cp config.jsonc.bak config.jsonc
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.jsonc','utf-8'));c.maxRetries='三';fs.writeFileSync('config.jsonc',JSON.stringify(c,null,2))"
```

Run: `npm run dev:electron`
Expected: `- maxRetries 必须是非负整数 (实际: "三")`；exit 1

Close: Ctrl+C

- [ ] **Step 3: 测试范围错**

```bash
cp config.jsonc.bak config.jsonc
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.jsonc','utf-8'));c.width=800;c.minWidth=900;fs.writeFileSync('config.jsonc',JSON.stringify(c,null,2))"
```

Run: `npm run dev:electron`
Expected: `- width (800) 必须 >= minWidth (900)`；exit 1

Close: Ctrl+C

- [ ] **Step 4: 测试 URL 协议错**

```bash
cp config.jsonc.bak config.jsonc
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.jsonc','utf-8'));c.targetUrl='ftp://x';fs.writeFileSync('config.jsonc',JSON.stringify(c,null,2))"
```

Run: `npm run dev:electron`
Expected: `- targetUrl 必须是合法的 http(s) URL (实际: "ftp://x")`；exit 1

Close: Ctrl+C

- [ ] **Step 5: 测试 JSONC 注释与尾逗号**

```bash
cp config.jsonc.bak config.jsonc
# 手动写一个带注释和尾逗号的 config.jsonc
cat > config.jsonc <<'EOF'
{
  // 注释测试
  "targetUrl": "http://localhost:5195/agent-user/assistant",
  "maxRetries": 3,
  "retryDelayMs": 5000,
  "width": 1180,
  "height": 820,
  "minWidth": 900,
  "minHeight": 700,  // 尾逗号
}
EOF
```

Run: `npm run dev:electron`
Expected: 正常加载（`[config] ✓ 已加载 ...`），exit 0

Close: Ctrl+C

- [ ] **Step 6: 恢复原始 config.jsonc**

Run: `mv config.jsonc.bak config.jsonc`
Expected: 文件还原为带 `//` 注释的 7 字段版本

- [ ] **Step 7: 验证恢复正常**

Run: `npm run dev:electron`
Expected: 正常启动

Close: Ctrl+C

---

## Task 12: 验证 `targetUrl` 生效（will-navigate 拦截）

**Files:** 无（验证任务）

- [ ] **Step 1: 改 targetUrl 到 9999 端口**

```bash
cp config.jsonc config.jsonc.bak
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.jsonc','utf-8'));c.targetUrl='http://localhost:9999/';fs.writeFileSync('config.jsonc',JSON.stringify(c,null,2))"
```

- [ ] **Step 2: 启动 dev**

Run: `npm run dev:electron`
Expected: 终端 `[config]   targetUrl: http://localhost:9999/`；contentView 加载失败（9999 端口可能未服务，触发 retryView 状态机）—— 这是预期行为

Close: Ctrl+C

- [ ] **Step 3: 恢复**

Run: `mv config.jsonc.bak config.jsonc`

---

## Task 13: 验证 Windows 免安装打包

**Files:** 无（验证任务，仅 Windows 平台）

- [ ] **Step 1: 执行打包**

Run: `npm run build:win:zip`
Expected: 
- 终端打印 `🎉 打包完成！`
- 路径 `release/算粒AI助手-0.1.0-x64.zip` 存在

- [ ] **Step 2: 解压到临时目录**

```bash
mkdir -p /tmp/portable-test
powershell -Command "Expand-Archive -Path 'release/算粒AI助手-0.1.0-x64.zip' -DestinationPath 'C:\\tmp\\portable-test' -Force"
```

（或用 7-Zip、文件管理器手动解压）

- [ ] **Step 3: 验证 config.jsonc 位置**

Run: `ls "C:/tmp/portable-test/算粒AI助手-0.1.0-x64/config.jsonc"`
Expected: 文件存在（`extraFiles` 在 Windows 落地 install root，与 `.exe` 同级）

如路径不同，搜索：
```bash
find "C:/tmp/portable-test" -name "config.jsonc"
```
Expected: 唯一命中，且与 `算粒AI助手.exe` 在同一目录

- [ ] **Step 4: 验证 config.jsonc 内容**

Run: `cat "C:/tmp/portable-test/算粒AI助手-0.1.0-x64/config.jsonc"`
Expected: 7 字段齐全（无 // 注释，因为 extraFiles 直接复制，不在 asar 内）

- [ ] **Step 5: 运行并验证窗口尺寸**

Run: `"C:/tmp/portable-test/算粒AI助手-0.1.0-x64/算粒AI助手.exe"`
Expected: 终端出现 `[config] ✓ 已加载 ...\config.jsonc`，主窗口打开尺寸 1180x820

Close: 关闭窗口

- [ ] **Step 6: 清理测试目录**

Run: `powershell -Command "Remove-Item 'C:\\tmp\\portable-test' -Recurse -Force"`

---

## Task 14: 验证 Windows NSIS 安装包

**Files:** 无（验证任务，仅 Windows 平台）

- [ ] **Step 1: 执行打包**

Run: `npm run build:win`
Expected: 
- 终端打印安装包路径 `release/算粒AI助手-0.1.0-x64-Setup.exe`
- 文件存在

- [ ] **Step 2: 静默安装到临时目录**

```bash
# 用 NSIS 的 /D 选项指定安装目录
"release/算粒AI助手-0.1.0-x64-Setup.exe" /S /D=C:\tmp\install-test
```

Expected: 静默安装完成；`C:\tmp\install-test\` 出现文件

- [ ] **Step 3: 验证 config.jsonc 位置**

Run: `ls "C:/tmp/install-test/config.jsonc"`
Expected: 文件存在（`extraFiles` 在 Windows NSIS 落地 install root，与 `.exe` 同级）

如路径不同，搜索：
```bash
find "C:/tmp/install-test" -name "config.jsonc"
```
Expected: 唯一命中

- [ ] **Step 4: 运行并验证**

Run: `"C:/tmp/install-test/算粒AI助手.exe"`
Expected: 加载 config.jsonc 成功，窗口 1180x820

Close: 关闭窗口

- [ ] **Step 5: 清理**

```bash
powershell -Command "Remove-Item 'C:\\tmp\\install-test' -Recurse -Force"
rm "release/算粒AI助手-0.1.0-x64-Setup.exe"
```

---

## Task 15: 验证 user-edited config.jsonc

**Files:** 无（验证任务）

- [ ] **Step 1: 改一份打包产物的 config.jsonc**

解压 `release/算粒AI助手-0.1.0-x64.zip` 到 `C:\tmp\edit-test\`

修改 `C:\tmp\edit-test\算粒AI助手-0.1.0-x64\config.jsonc`：
- 把 `"width": 1180` 改为 `"width": 950`
- 把 `"height": 820` 改为 `"height": 750`

- [ ] **Step 2: 启动可执行文件**

Run: `"C:/tmp/edit-test/算粒AI助手-0.1.0-x64/算粒AI助手.exe"`
Expected: 终端出现 `[config]   窗口: 950x750 (min 900x700)`；主窗口 950x750 启动

（注：测试时 `width` 必须 `>= minWidth (900)`，`height >= minHeight (700)`，否则校验失败）

- [ ] **Step 3: 清理**

Run: `powershell -Command "Remove-Item 'C:\\tmp\\edit-test' -Recurse -Force"`

---

## Task 16: 最终复查与提交

**Files:** 无（复查任务）

- [ ] **Step 1: 检查 git 状态**

Run: `git status`
Expected: working tree clean（无未提交修改）

- [ ] **Step 2: 查看 commit 历史**

Run: `git log --oneline -20`
Expected: 看到本计划全部 commit（feature、build、docs、chore）

- [ ] **Step 3: 验证 dist-electron 产物存在**

Run: `ls dist-electron/main.js dist-electron/preload.js`
Expected: 两个文件存在（最后一次 `npm run build:electron` 产物）

- [ ] **Step 4: 标记计划完成**

所有 14 个文件变更任务 + 2 个验证任务已完成。`config.jsonc` 可用，前端无需改动。

---

## 自检要点

实施时如发现以下问题，回到对应任务修复：

| 现象 | 排查方向 |
|------|---------|
| `npm run dev:electron` 报 `SyntaxError: await is only valid in async function` | Task 5 未生效或 esbuild 版本不识别 `topLevelAwait` |
| 启动后看到 `_config_path not found` 或类似 | Task 3 中 `resolveConfigPath` 的 darwin 分支路径有误 |
| `error.html` 重试按钮失效 | 改动未影响 IPC（Task 4 没碰 preload） |
| 打包后 `config.jsonc` 出现在错误目录 | Task 6 `extraFiles` 路径配置错；可能需在 Task 6 重新查 electron-builder 文档 |
| `field required` 错误但信息缺实际值 | Task 3 `validateConfig` 错误信息模板未含实际值 |
| `process.exit(1)` 后 dev 进程不退 | Task 3 没在错误处理中 `process.exit(1)`，仅 `throw` |
