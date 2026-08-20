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

应用通过 `config.jsonc` 实现行为配置。该文件位于**安装目录的可执行程序同级位置**：

- **macOS**: `<productFilename>.app/Contents/config.jsonc`
  - 例如：`/Applications/算粒AI助手.app/Contents/config.jsonc`（编辑此文件需要管理员权限）
- **Windows**: `<exe-dir>/config.jsonc`
  - 例如：`C:\Program Files\算粒AI助手\config.jsonc`

### 字段说明

| 字段 | 类型 | 含义 |
|------|------|------|
| `targetUrl` | string | 启动后 contentView 加载的 URL，仅接受 `http://` 与 `https://` 协议 |
| `maxRetries` | integer ≥ 0 | URL 加载失败时的最大重试次数（`0` 表示不重试，直接进入错误页） |
| `retryDelayMs` | integer ≥ 0 | 每次重试间隔毫秒数 |
| `width` | integer ≥ `minWidth` | BrowserWindow 初始宽度（像素） |
| `height` | integer ≥ `minHeight` | BrowserWindow 初始高度（像素） |
| `minWidth` | integer ≥ 1 | BrowserWindow 最小宽度（像素） |
| `minHeight` | integer ≥ 1 | BrowserWindow 最小高度（像素） |

### 格式

`config.jsonc` 是 JSONC 格式（支持 `//` 单行注释），示例：

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

- **缺失**：`config.jsonc` 不存在时，启动失败（exit 1）并打印尝试路径
- **字段缺失或类型错误**：启动失败（exit 1）并打印具体校验错误
- **修改后**：重启应用生效（不热重载，运行时不会重新读取）

> 注：所有校验错误都是硬失败，不会使用默认值兜底。

### 仓库构建

构建时 `electron-builder` 通过 `extraFiles` 把仓库根 `config.jsonc` 拷贝到 install root（即上述安装目录位置）。若修改了仓库根 `config.jsonc`，需要重新执行 `npm run build` 并重新安装应用。

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