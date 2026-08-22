# 算粒AI助手 - 桌面端

> 基于 Electron + TypeScript 的 AI 桌面助手（macOS / Windows），启动后加载 `http://localhost:5195/agent-user/assistant`

[![Build Status](https://github.com/hdcljt/macapp/actions/workflows/build-macos.yml/badge.svg)](https://github.com/hdcljt/macapp/actions/workflows/build-macos.yml)
[![Latest Release](https://img.shields.io/github/v/release/hdcljt/macapp)](https://github.com/hdcljt/macapp/releases/latest)
[![License](https://img.shields.io/github/license/hdcljt/macapp)](./LICENSE)

## ✨ 特性

- 🎨 **macOS 原生体验**：自定义标题栏、毛玻璃效果、SF Pro 字体
- ⚡ **极速开发**：Vite + HMR，秒级热更新
- 🎯 **TypeScript**：完整类型支持
- 📦 **多端打包**：GitHub Actions 自动构建 macOS（x64 + arm64 + universal）和 Windows（NSIS + 便携）
- 🚀 **零配置启动**：一行命令跑起来

## 🛠 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | Electron 43 |
| 语言 | TypeScript 7 |
| 构建 | esbuild |
| 打包 | electron-builder 26 |

## 📁 项目结构

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

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 开发模式

```bash
npm run dev
```

Electron 直接加载外部 URL `http://localhost:5195/agent-user/assistant`。启动前请先在 5195 端口运行后端服务。

### 3. 构建打包

```bash
# macOS（需 Mac 或 CI）
npm run build:mac           # 默认架构（darwin 默认）
npm run build:mac:universal # Intel + Apple Silicon 合并包

# Windows（在 Windows 上执行，或在 CI）
npm run build:win:zip       # 便携 ZIP
npm run build:win:nsis      # NSIS 安装程序 + 便携 ZIP
```

产物在 `release/{version}/` 目录下。

## 📦 GitHub Actions 自动化打包

`.github/workflows/build-macos.yml` 自动构建：

| Job | Runner | 产物 |
|-----|--------|------|
| `build-macos` (x64) | macos-14 | DMG + ZIP |
| `build-macos` (arm64) | macos-14 | DMG + ZIP |
| `build-macos-universal` | macos-14 | Universal DMG + ZIP |
| `build-windows` | windows-latest | NSIS installer + 便携 ZIP |

### 触发条件

- **推送**到 `main` 或 `develop` 分支
- **推送 tag** `v*`（如 `v0.1.0`，会自动创建 GitHub Release）
- **Pull request** 到 `main`
- **手动触发**：GitHub → Actions → Run workflow

### 下载产物

- 每次构建后可在 Actions → Run → Artifacts 下载（保留 30 天）
- Tag 构建会自动发布到 GitHub Releases

### 配置自定义 Runner 镜像

工作流默认使用 npmmirror（中国大陆加速）。如需切换：

```yaml
- name: 配置 npm 镜像
  run: |
    npm config set registry https://registry.npmjs.org  # 官方源
    echo "ELECTRON_MIRROR=https://github.com/electron/electron/releases/download" >> $GITHUB_ENV
```

## 🍎 macOS 专属配置

应用使用了以下 macOS 特性：

1. **隐藏标题栏**：`titleBarStyle: 'hiddenInset'`
2. **自定义红绿灯按钮位置**：`trafficLightPosition: { x: 16, y: 16 }`
3. **SF Pro 字体**：与系统一致
4. **毛玻璃效果**：`backdrop-filter`

> 注：macOS 专属 UI 必须在 Mac 上测试。建议在 Windows 上开发，Mac 上验证。

## ⚙️ 配置文件

应用通过 `config.jsonc` 实现行为配置。应用采用「bundled default + 首次启动复制到 userData」模型：

### 配置文件位置

应用首次启动时会自动生成一份可编辑的配置文件：

- **macOS**：`~/Library/Application Support/算粒AI助手/config.jsonc`
- **Windows**：`%APPDATA%\算粒AI助手\config.jsonc`

应用启动时**优先读取用户目录的可编辑副本**；首次启动时如不存在，自动从应用包内的 bundled default 复制一份到上述路径。

### bundled default 位置（只读种子）

应用包内还携带一份「出厂默认」配置，用于首次启动时复制，**用户无需手动操作**：

- **macOS**：`/Applications/算粒AI助手.app/Contents/Resources/config.jsonc`（`<.app>` bundle 内，codesign 保护，正常情况下不可编辑）
- **Windows**：`<安装目录>\resources\config.jsonc`（如 `%LOCALAPPDATA%\Programs\算粒AI助手\resources\config.jsonc`）

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

- **优先读取** userData 中的副本（用户可编辑）
- **首次启动**：userData 没有时，从 bundled default 复制；复制成功 → 正常使用，复制失败（权限不足）→ 降级读 bundled + 终端警告「无法写入 userData，用户编辑不会持久化」
- **bundled 缺失**（打包漏文件）：启动失败（exit 1）并打印尝试路径
- **JSONC 解析失败**：JSONC 语法错误，启动失败（exit 1）并打印错误位置
- **字段缺失或类型错误**：启动失败（exit 1）并打印具体校验错误
- **修改后**：重启应用生效（不热重载，运行时不会重新读取）

> 注：所有校验错误都是硬失败，不会使用默认值兜底。

### 恢复出厂默认

删除上述 userData 路径下的 `config.jsonc`，下次启动时会自动从应用包内的 bundled default 重新生成。

### 自定义部署（运维）

批量部署时如需预设统一配置，改应用包内的 bundled default 后重新打包（userData 副本会保持用户上次编辑，不会被覆盖）：

- **macOS**：`/Applications/算粒AI助手.app/Contents/Resources/config.jsonc`
- **Windows**：`<安装目录>\resources\config.jsonc`

### 开发模式（`npm run dev`）

dev 模式仍读仓库根 `config.jsonc`，不走 userData 模型（方便开发者日常编辑）。重启 dev server 后生效。

### 仓库构建

构建时 `electron-builder` 通过 `build.extraResources` 把仓库根 `config.jsonc` 拷贝到：

- macOS：`<App>.app/Contents/Resources/config.jsonc`（标准资源目录，codesign 安全）
- Windows：`<安装目录>\resources\config.jsonc`

若修改了仓库根 `config.jsonc`，需要重新执行 `npm run build` 并重新安装应用（只影响 bundled default，已部署用户的 userData 副本不受影响）。

## 🌐 跨平台开发流程

```
1. Windows 上编写代码（npm run dev 调试）
2. 提交代码到 Git（git push origin main）
3. GitHub Actions 自动构建 macOS + Windows
4. 下载 .dmg / .exe 在目标机器测试
5. 创建 tag（如 v0.1.0）触发正式 Release
```

## 📝 自定义开发

### 修改主题色

编辑 `src/index.css`：

```css
@theme {
  --color-bg-gradient-start: #E8F4FF;
  --color-bg-gradient-mid: #F0E8FF;
  --color-bg-gradient-end: #FFE8F0;
}
```

### 添加新的 AI 应用

编辑 `src/data/features.ts`：

```ts
export const aiApps: AIApp[] = [
  // 添加新应用
  { id: 'newai', name: 'NewAI', icon: 'N', bgColor: 'bg-red-500' },
];
```

### 添加新功能区块

在 `src/data/features.ts` 的 `featureSections` 中添加。

## 📋 日志文件

应用启动后会在 `userData/logs/main.log` 写入日志，便于排查启动问题：

- **macOS**：`~/Library/Application Support/算粒AI助手/logs/main.log`
- **Windows**：`%APPDATA%\算粒AI助手\logs\main.log`

> dev 模式下路径使用 `package.json` 的 `name` 字段（`macapp`），而非 `productName`；打包后才会用产品名目录。

### 日志格式

每行格式：`2026-08-21T12:34:56.789 [LEVEL] [module] message`

- 时间戳：本地时区 ISO 8601 毫秒精度
- 级别：`DEBUG` / `INFO` / `WARN` / `ERROR`
- 模块：`main` / `config` / `renderer` 等

每次启动写入 header：`=== log started at <ISO> (<platform>, electron <version>) ===`
进程退出前写入 footer：`=== log ended at <ISO> ===`

### 日志轮转

- 单文件上限 5MB
- 超过时轮转：`main.log` → `main.log.1` → `main.log.2` → `main.log.3`
- 最老的 `main.log.3` 被丢弃
- 最多保留 3 个备份，总量约 20MB

### 渲染进程日志

渲染进程（splash / retry / error 页面）可通过 `window.electronAPI.log(level, message)` 写入日志，模块名标记为 `renderer`：

```js
window.electronAPI.log('error', 'splash shown after 5s');
window.electronAPI.log('warn', 'retry attempt 2/3');
```

### 常见用法

```bash
# macOS：实时查看最新日志
tail -f ~/Library/Application\ Support/算粒AI助手/logs/main.log

# Windows：查看最新日志
type %APPDATA%\算粒AI助手\logs\main.log

# 清空日志（保留目录）
rm ~/Library/Application\ Support/算粒AI助手/logs/main.log*
del /Q %APPDATA%\算粒AI助手\logs\main.log*
```

## 🔄 在线更新

应用启动时会自动检查 GitHub Releases 上的最新版本，发现新版后弹窗让用户确认是否更新。

### 工作流程

1. 应用启动后异步检查 GitHub Releases
2. 发现新版 → 弹窗显示版本号 + Release Notes
3. 用户选择「立即更新」→ 下载新版本
4. **Windows**：下载完成后自动安装并重启
5. **macOS**（ad-hoc 签名场景）：下载 DMG 后需用户手动拖入「应用程序」文件夹

### 配置更新行为

在 `config.jsonc` 中可控制：

```jsonc
{
  // 是否启用自动检查更新（默认 true）
  "autoUpdate": true,
  // 更新通道：stable（正式版）/ beta（含预发布）
  "updateChannel": "stable",
  // dismiss 后静默期（小时）。误点「以后再说」想立即再看 → 改 0 后重启
  "dismissCooldownHours": 24
}
```

### 用户选择

- **「立即更新」**：开始下载 + 进度条 + 下载完成后弹「立即安装」
- **「以后再说」**：关闭对话框，24 小时内不再提示同一版本

### macOS 签名说明

> ⚠️ **首次启动会触发 Gatekeeper**：因项目使用 ad-hoc 签名（未走 Apple Developer ID + 公证），macOS 首次启动 dmg 时会弹「无法验证开发者」或「已损坏」警告。处理方式：在「系统设置 → 隐私与安全性」点「仍要打开」或在终端执行 `xattr -dr com.apple.quarantine /Applications/算粒AI助手.app` 后即可正常运行。

当前 ad-hoc 签名不支持 Squirrel 增量更新（需要 Apple Developer ID 签名 + 公证）。

**实际行为**：macOS 检测到新版后下载完整 DMG，弹窗引导用户手动替换。

未来配置正式 Apple Developer ID 后，无需修改代码即可启用 macOS 增量更新。

### 调试

dev 模式下查看更新相关日志：

```bash
# macOS
tail -f ~/Library/Application\ Support/算粒AI助手/logs/main.log | grep updater

# Windows
type %APPDATA%\算粒AI助手\logs\main.log | findstr updater
```

### 关闭自动更新

运维场景下需要禁用，修改部署环境的 `config.jsonc`：

```jsonc
{ "autoUpdate": false }
```

## 🛡️ 离线兜底页面

通过 `config.jsonc` 的 `useOfflineFallback` 字段选择两种策略：

| 字段值 | 流程 | 适用场景 |
|---|---|---|
| `true`（v0.5.7+ **默认**） | **offline-first**：启动直接显示离线页 → 异步加载 URL；成功切到线上，失败/崩溃留在离线页 | 推荐。提供"始终有可用 UI"的最佳体验 |
| `false` | **splash → retry → error**：先显示 splash → 失败重试 N 次 → errorView | 旧 v0.5.6 行为，保留供需要明确"加载失败弹错误页"流程的场景使用 |

### 策略 A：offline-first（`useOfflineFallback: true`）

app 一启动**立即**显示离线兜底页（Vite 产物，无网络依赖），同时**异步**尝试连接 `targetUrl`：

- **成功** → 切到 contentView（线上页面）
- **失败 / 渲染进程崩溃** → 继续停留在离线页，TopBar「重新连接」按钮始终可点

离线页 UI 与 `http://localhost:5195/agent-user/assistant` 一致，提供熟悉的导航 + 功能介绍 + 输入栏体验。

#### 连接状态提示

离线页 TopBar 右侧小 toast 实时反映主进程状态：

- **spinner + 正在连接在线服务…**：主进程正在尝试连接 `targetUrl`
- **🔄 重新连接**：连接结束（成功 → 已切到 contentView / 失败 → 留在本页，可点此按钮重试）

### 策略 B：legacy（`useOfflineFallback: false`）

旧 v0.5.6 行为：

| 场景 | 行为 |
|---|---|
| 加载成功 | 切到 contentView |
| 加载失败 | retryView 重试 N 次 → 失败切到 errorView |
| render-process-gone | retryView 重试 N 次 → 失败切到 errorView |
| 重连方式 | errorView「重试」按钮 |

### 旧 splash / retry / error 静态页

保留在 `electron/static/`，`build-electron.js` 仍会把它们复制到 `dist-electron/`：

- 策略 A 不引用
- 策略 B 仍引用

如果未来需要彻底切到策略 A，可以从 `electron/static/` 删除 `splash.html` / `retry.html` / `error.html` 并同步 `build-electron.js` 的复制列表。

### 独立调试（仅离线页）

```bash
npm run dev:offline
# 浏览器打开 http://localhost:5175/
```

仅启动 Vite dev server，不依赖 Electron 主进程，方便 UI 调试与样式调整。
注意：dev 模式没有 `window.electronAPI`（preload 只在 Electron 中运行），TopBar 不会显示连接状态 toast，保持默认「重新连接」按钮可点击（仅 console 提示）。

端口选择：5175 是 Vite 5+ 默认端口，且与 `targetUrl` 常用的 5195（deerflow agent-user dev server）不冲突——调试离线页 UI 时可同时跑两端做对比。

## 🐛 常见问题

### Q1: Windows 上打包 EPERM 错误？
Windows Defender 会在 electron-builder 解压 Electron 时锁定临时目录。
解决方案：使用 `npm run build:win:nsis`（脚本已绕过）。
或在 CI 上构建（GitHub Actions Windows runner 无此问题）。

### Q2: Windows 上运行看不到红绿灯按钮？
正常，红绿灯按钮是 macOS 专属。

### Q3: macOS 打包失败提示签名错误？
本项目配置为禁用公证（内部分发），如需上架需配置 Apple Developer 证书。

### Q4: 想要自定义图标？
```bash
# 替换 SVG 源文件
build/icon.svg

# 重新生成所有尺寸
npm run icon:generate
```

## 📄 License

MIT