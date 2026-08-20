# config.jsonc 用户可编辑 — 设计文档

日期：2026-08-20
主题：在打包后让 `config.jsonc` 在 macOS 和 Windows 上都可由用户/运维自由编辑。改为「bundled default + 首次启动复制到 userData」模型，应用启动时优先读取 userData 中的副本。

## 背景

2026-08-20 的上一个 spec（[2026-08-20-electron-config-jsonc-design.md](2026-08-20-electron-config-jsonc-design.md)）已经把硬编码值抽离到 `config.jsonc`，并通过 `mac.extraResources` + `win.extraFiles` 把配置打进安装包：

| 平台 | 当前落地路径 | 可编辑？ |
|------|------------|---------|
| macOS | `<.app>/Contents/Resources/config.jsonc` | ❌ `/Applications` 下 bundle 只读 + codesign 兼容约束 |
| Windows（perMachine:false） | `<install-dir>/config.jsonc` | ✅ 当前用户拥有此目录 |

核心问题：

- macOS 用户/运维**改不了**配置（`.app` bundle 在 `/Applications` 下只读，且 `Contents/Resources/` 是 codesign 要求位置，移到根目录会破坏签名）
- Windows 用户**能改**但跨平台行为不一致
- 配置文件应该按平台规范放到用户可写的标准位置（macOS: `~/Library/Application Support/<App>/`，Windows: `%APPDATA%\<App>\`）

## 目标

1. **跨平台一致**：macOS 和 Windows 用户都能编辑 `config.jsonc`
2. **遵循规范**：使用 `app.getPath('userData')`（macOS → `~/Library/Application Support/算粒AI助手/`、Windows → `%APPDATA%\算粒AI助手\`）
3. **首次启动零摩擦**：自动从 bundled default 复制到 userData，用户无需手动操作
4. **dev 模式行为不变**：仍读 `cwd/config.jsonc`，方便开发者日常编辑
5. **失败硬退出**：bundled 缺失（打包漏文件）必须 `exit(1)`；userData 配置损坏也 `exit(1)`
6. **不引入**：自动化测试、热重载、schema 自动迁移、多 profile

## 设计

### 1. 架构

```
electron/
├── main.ts          ← 改：app.whenReady() 内 await loadConfig()，createMainWindow(config)
├── config.ts        ← 改：resolveConfigPath() 改为 async，新增 getBundledConfigPath()，新增 userData 复制逻辑
└── preload.ts       ← 不变

config.jsonc        ← 不变（仓库根，git 跟踪的 bundled default）
package.json        ← 改：删除 extraFiles（保留 extraResources，bundled 不再需要两份）
README.md           ← 改：新增「配置文件位置」章节
BUILD.md            ← 改：Q7（splash 转圈排查）追加日志目录提示
```

### 2. 双位置模型

| 角色 | 来源 | 路径 | 权限 |
|------|------|------|------|
| Bundled default（只读种子） | `package.json → extraResources` | macOS: `<.app>/Contents/Resources/config.jsonc`<br>Windows: `<install-dir>/resources/config.jsonc` | 系统保护（macOS bundle 只读）/ 当前用户拥有（Windows perMachine:false） |
| User-editable（实际读取） | 首次启动从 bundled 复制 | macOS: `~/Library/Application Support/算粒AI助手/config.jsonc`<br>Windows: `%APPDATA%\算粒AI助手\config.jsonc` | 当前用户完全可写 |

### 3. 路径解析与加载流程

```
app.whenReady()
  ↓
loadConfig() (async)
  ↓
resolveConfigPath() (async)
  ↓
  dev 模式（app.isPackaged === false）：
    ├─ cwd/config.jsonc 存在 → 返回
    └─ 不存在 → 抛 ConfigNotFoundError（行为保持现状）
  ↓
  生产模式（app.isPackaged === true）：
    ├─ userData/config.jsonc 存在 → 返回（用户编辑生效）
    └─ 不存在 →
         ├─ bundled 存在 → mkdir userData, copyFile → 返回 userData 路径
         │                （复制失败时降级返回 bundled 路径 + console.warn）
         └─ bundled 不存在 → 抛 ConfigNotFoundError（exit 1）
  ↓
fs.readFileSync → jsonc-parser.parse → validateConfig（保持现状）
  ↓
返回 LoadedConfig
```

### 4. config.ts 改动详情

**新增函数**

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

**`resolveConfigPath()` 改造**

```ts
export async function resolveConfigPath(): Promise<string> {
  // dev 模式：cwd（行为保持现状）
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
    // 复制失败（权限不足 / 磁盘满 / 只读卷）→ 降级读 bundled
    console.warn(`[config] ⚠ 无法写入 userData: ${(err as Error).message}`);
    console.warn(`[config]   回退到 bundled default（用户编辑不会持久化）: ${bundledPath}`);
    return bundledPath;
  }
}
```

**`loadConfig()` 改造**

- 签名：`(): LoadedConfig` → `(): Promise<LoadedConfig>`
- 函数体第一行 `configPath = resolveConfigPath()` → `configPath = await resolveConfigPath()`
- 其余代码（读取、解析、校验、错误处理、console 输出）完全保持现状

### 5. main.ts 改动详情

**diff 摘要**

```diff
 import { app, BrowserWindow, WebContentsView, ipcMain, shell } from 'electron';
 import path from 'node:path';
 declare const __dirname: string;

 import { loadConfig } from './config';
+import type { LoadedConfig } from './config';

-// loadConfig() 同步函数（失败由 config.ts 内部 process.exit(1)），无需 await
-// 不能用 await 顶层调用：esbuild 0.28 + format:cjs 拒绝顶层 await（即使包 async IIFE）
-const config = loadConfig();
-const isDev = !app.isPackaged;
-const TARGET_URL = config.targetUrl;
-const MAX_RETRIES = config.maxRetries;
-const RETRY_DELAY_MS = config.retryDelayMs;
-const ALLOWED_ORIGIN_PREFIX = config.allowedOriginPrefix;
+// loadConfig() 改为 async：内部调用 app.getPath('userData') 需要 app.whenReady() 之后
+// createMainWindow 改为接收 config 参数（消除顶层闭包依赖）

 // ...其他模块级变量保持不变（mainWindow / loadingView / retryView / errorView / contentView / retryCount / loadFailed）

-function createMainWindow() {
+function createMainWindow(config: LoadedConfig) {
+  const isDev = !app.isPackaged;
+  const TARGET_URL = config.targetUrl;
+  const MAX_RETRIES = config.maxRetries;
+  const RETRY_DELAY_MS = config.retryDelayMs;
+  const ALLOWED_ORIGIN_PREFIX = config.allowedOriginPrefix;
+
   mainWindow = new BrowserWindow({
     width: config.width,        // 保持原样，从顶层 const 改成函数参数 config.X
     height: config.height,
     minWidth: config.minWidth,
     minHeight: config.minHeight,
     // ...其余字段保持不变
   });
   // ...函数体其余部分保持不变
 }

-app.whenReady().then(() => {
-  createMainWindow();
+app.whenReady().then(async () => {
+  const config = await loadConfig();
+  createMainWindow(config);

   app.on('activate', () => {
     if (BrowserWindow.getAllWindows().length === 0) {
-      createMainWindow();
+      createMainWindow(config);
     }
   });
 });
```

**改动点行号定位**（基于当前 [electron/main.ts](electron/main.ts)）

| 位置 | 改动 |
|------|------|
| [main.ts:7](electron/main.ts#L7) | 新增 `import type { LoadedConfig } from './config';` |
| [main.ts:9-16](electron/main.ts#L9-L16) | 删除顶层 `loadConfig()` 调用和派生常量 |
| [main.ts:70](electron/main.ts#L70) | 函数签名改为 `createMainWindow(config: LoadedConfig)` |
| [main.ts:71](electron/main.ts#L71) | 在函数体最前面加上 `isDev` / `TARGET_URL` / `MAX_RETRIES` / `RETRY_DELAY_MS` / `ALLOWED_ORIGIN_PREFIX` 提取 |
| [main.ts:193-201](electron/main.ts#L193-L201) | `app.whenReady().then(...)` 改为 `async`，`await loadConfig()`，把 `config` 传给 `createMainWindow` |

### 6. package.json 改动

```diff
   "build": {
     ...
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
     "mac": { ... },
     "win": { ... }
   }
```

**为什么删 `extraFiles` 保留 `extraResources`**：

| 字段 | macOS 落地 | Windows 落地 | 本 spec 中的用途 |
|------|-----------|------------|----------------|
| `extraResources` | `<.app>/Contents/Resources/config.jsonc` | `<install-dir>/resources/config.jsonc` | ✅ **bundled default**（保留） |
| `extraFiles` | `<.app>/Contents/config.jsonc` | `<install-dir>/config.jsonc` | ❌ 冗余（代码不再读这里） |

保留 `extraResources` 是因为 macOS codesign 要求 `config.jsonc` 必须在 `Contents/Resources/`（参见 [config.ts:69](electron/config.ts#L69) 注释）。Windows 上虽然 `extraResources` 落地在 `resources/` 子目录而非 `.exe` 同级，但代码只读 userData，这份 bundled 仅作复制种子，路径无关紧要。

### 7. 落地路径效果

| 部署方式 | bundled 路径 | userData 路径 | 代码读取 |
|---------|------------|--------------|---------|
| dev（`npm run dev:electron`） | N/A | N/A | `cwd/config.jsonc` |
| Windows NSIS 安装（perMachine:false） | `%LOCALAPPDATA%\Programs\算粒AI助手\resources\config.jsonc` | `%APPDATA%\算粒AI助手\config.jsonc` | userData ✅ |
| Windows 免安装（zip 解压） | `<exe-dir>/resources/config.jsonc` | `%APPDATA%\算粒AI助手\config.jsonc` | userData ✅ |
| macOS 任意位置 | `<.app>/Contents/Resources/config.jsonc` | `~/Library/Application Support/算粒AI助手/config.jsonc` | userData ✅ |

### 8. 错误处理

| 场景 | 行为 |
|------|------|
| dev 模式 cwd 没有 config | `process.exit(1)`（保持现状） |
| 生产模式 userData 没有 + bundled 没有 | `process.exit(1)`，错误信息列出两个尝试路径（保持现状，bundled 缺失 = 打包 bug） |
| 生产模式 userData 没有 + bundled 有 + copy 成功 | 正常使用 + console.log「已初始化用户配置」 |
| 生产模式 userData 没有 + bundled 有 + copy 失败（EACCES 等） | 降级读 bundled + console.warn「无法写入 userData」（用户编辑不持久化但能跑） |
| userData 配置文件损坏（解析失败） | `process.exit(1)`（保持现状，不自动恢复） |
| userData 字段缺失/类型错 | `process.exit(1)`（保持现状） |

### 9. README.md 新增章节

```markdown
## 配置文件位置

应用首次启动时会自动生成一份可编辑的配置文件：

- **macOS**：`~/Library/Application Support/算粒AI助手/config.jsonc`
- **Windows**：`%APPDATA%\算粒AI助手\config.jsonc`

可编辑字段：

- `targetUrl`：应用加载的网页地址
- `maxRetries`：URL 加载失败时的重试次数
- `retryDelayMs`：每次重试的间隔（毫秒）
- `width` / `height`：窗口初始尺寸
- `minWidth` / `minHeight`：窗口最小尺寸

### 恢复出厂默认

删除上述路径下的 `config.jsonc`，下次启动时会自动从应用包内的默认配置重新生成。

### 自定义部署（运维）

批量部署时如需预设统一配置，改应用包内的 bundled default 后重新打包：

- **macOS**：`<.app>/Contents/Resources/config.jsonc`
- **Windows**：`<install-dir>/resources/config.jsonc`
```

### 10. 关键文件变更清单

| 文件 | 动作 |
|------|------|
| `electron/config.ts` | **修改**：`loadConfig()` 改 async；`resolveConfigPath()` 改 async + 加入 userData 优先 + 首次复制逻辑；新增 `getBundledConfigPath()` |
| `electron/main.ts` | **修改**：删除顶层 `loadConfig()` 调用；`createMainWindow(config)` 改函数签名；`app.whenReady().then(async () => { const config = await loadConfig(); createMainWindow(config); ... })` |
| `package.json` | **修改**：删除 `extraFiles` 块（保留 `extraResources`） |
| `README.md` | **修改**：新增「配置文件位置」章节 |
| `BUILD.md` | **修改**：Q7（splash 转圈排查）追加日志目录提示（顺便；非阻塞） |

## 范围

本设计**不**包含：

- ❌ 自动化测试（项目当前无测试基建，用户明确不引入 Vitest）
- ❌ Schema 自动迁移（userData 配置缺字段时硬失败，不自动补默认）
- ❌ 配置热重载
- ❌ GUI 配置编辑器
- ❌ 多 profile / 多配置文件切换
- ❌ 环境变量覆盖
- ❌ 配置导入/导出 UI
- ❌ macOS `/Applications` bundle 写权限特殊处理（用 userData 兜底已解决，无需绕过 bundle）
- ❌ Windows 安装器预填 userData（普通场景 bundled default 已足够）

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| App 更新时 bundled config 新增字段，老用户 userData 缺字段 → 启动失败 | 老用户体验中断 | README 说明「删除 userData config 可恢复默认」；后续 spec 可做自动迁移 |
| userData 复制失败时静默降级，用户改了配置重启发现没生效 | 用户困惑 | console.warn 输出明确；后续可加 UI 提示 |
| macOS `app.getPath('userData')` 中文路径（`算粒AI助手`）出现编码问题 | 配置读写失败 | Node.js fs 默认 UTF-8，实测无问题；如出现改用 ASCII 别名 |
| 应用从 Windows 安装目录运行（如解压 zip 到 `C:\Program Files\`），但 perMachine:false 仍装到 `%LOCALAPPDATA%` | NSIS 安装到 `%LOCALAPPDATA%`，免安装场景 userData 仍写到当前用户 | 符合预期；NSIS 路径当前不变 |
| 用户/运维同时编辑了 bundled 和 userData | 哪个生效？ | **userData 永远优先**（即使 bundled 是更新版本）；运维应同步两边 |
| 降级到 bundled 后用户编辑，下次启动仍然丢失 | 用户困惑 | console.warn 已说明；用户可手动 chmod / 修复目录权限 |

## 验收标准

### dev 模式

1. **dev 正常启动**：仓库根有 `config.jsonc`，`npm run dev:electron` 启动成功；终端日志显示 `[config] ✓ 已加载`
2. **dev 缺配置**：删除 `config.jsonc` 后启动 → 终端报错，exit 1
3. **dev 改字段**：编辑 `config.jsonc` 的 `targetUrl` → 重启 → 新 URL 生效

### Windows 打包

4. **首次启动**：`npm run build:win:nsis` 装新版 → 应用启动成功
5. **userData 自动生成**：验证 `%APPDATA%\算粒AI助手\config.jsonc` 存在
6. **二次启动**：再次启动 → 应用正常加载（用 userData 配置）
7. **编辑生效**：编辑 `%APPDATA%\算粒AI助手\config.jsonc` 的 `targetUrl` → 重启 → 新 URL 生效
8. **恢复默认**：删除 `%APPDATA%\算粒AI助手\config.jsonc` → 重启 → 重新生成
9. **bundled 仍在**：验证 `%LOCALAPPDATA%\Programs\算粒AI助手\resources\config.jsonc` 存在（bundled default 未被改动）
10. **降级路径**（手动 chmod 模拟）：`icacls "%APPDATA%\算粒AI助手" /deny "%USERNAME%":(W)` → 启动 → 应用能跑 + console 出现「无法写入 userData」警告

### macOS 打包

11. **首次启动**：安装新版 → 应用启动成功
12. **userData 自动生成**：验证 `~/Library/Application Support/算粒AI助手/config.jsonc` 存在
13. **编辑生效**：编辑该文件的 `targetUrl` → 重启 → 新 URL 生效
14. **恢复默认**：删除该文件 → 重启 → 重新生成
15. **bundled 仍在**：验证 `/Applications/算粒AI助手.app/Contents/Resources/config.jsonc` 仍存在（codesign 兼容）

### 文档

16. README.md 新章节内容齐全，路径、字段、恢复方法都写清楚
17. 升级到新版本的用户在 CHANGELOG / commit message 中收到迁移说明（Windows 运维曾改过安装目录配置的需手动迁移到 userData）

## 后续可选（不在本次范围）

- 引入 vitest 自动化测试 resolveConfigPath 6 个核心场景
- Schema 自动迁移（userData 缺字段时用 bundled default 补齐）
- 应用内「编辑配置」按钮：调用 `shell.openPath(userConfigPath)`
- 配置热重载（IPC 监听文件变化）
- 多 profile 切换（开发/生产/自定义）
- 环境变量覆盖（`MACAPP_TARGET_URL` 等）
- 跨平台应用启动日志到文件（用户原始问题的另一半，本 spec 不包含）
- macOS 应用启动时 console.log 重定向到 `~/Library/Logs/算粒AI助手/main.log`

## 决策记录

| 决策 | 选择 | 否决项 |
|------|------|--------|
| 文件位置（用户可编辑副本） | `app.getPath('userData')/config.jsonc` | 安装根目录（macOS 不可写）；bundled 内（macOS codesign 限制） |
| 默认值来源 | bundled default（`extraResources`） | 硬编码到 `loadConfig()`；远程下载 |
| 首次启动行为 | 自动从 bundled 复制到 userData | 弹窗让用户选；手动复制指引 |
| 复制失败行为 | 降级读 bundled + warn | exit 1（用户体验差）；silent fallback（用户困惑） |
| dev 模式路径 | 保持 `cwd/config.jsonc` | 也走 userData（开发者不便） |
| bundled 缺失行为 | `exit 1`（硬失败） | 用空对象启动；用代码硬编码默认值 |
| userData 配置损坏 | `exit 1`（保持现状） | 自动备份+回退 bundled（用户工作丢失风险） |
| 配置变更生效时机 | 重启后生效 | 热重载（本次范围外） |
| 跨平台路径解析 | 平台硬编码 if/else（macOS `..Resources` vs Windows `resources`） | 用 electron-builder 配置注入；统一改 `extraFiles`（破坏 codesign） |
| 测试 | 不引入测试框架（用户明确） | vitest；jest；node:test |
| package.json 配置 | 只保留 `extraResources` | 同时保留 `extraFiles`（冗余，浪费打包空间） |