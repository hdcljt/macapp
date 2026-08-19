# 算粒AI助手 - 桌面端

> 基于 Electron + React + TypeScript 的 AI 桌面助手（macOS / Windows）

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
| UI | React 19 + TypeScript 7 |
| 构建 | Vite 8 |
| 样式 | Tailwind CSS 4（CSS-based 配置） |
| 打包 | electron-builder 26 |

## 📁 项目结构

```
macapp/
├── electron/                 # Electron 主进程
│   ├── main.ts              # 主进程入口
│   └── preload.ts           # 预加载脚本
├── src/                     # React 渲染层
│   ├── components/          # UI 组件
│   │   ├── TopBar.tsx
│   │   ├── AIAppsCarousel.tsx
│   │   ├── FeatureSection.tsx
│   │   ├── FeatureCard.tsx
│   │   ├── BottomTabBar.tsx
│   │   └── InputBar.tsx
│   ├── data/
│   │   └── features.ts      # 数据定义
│   ├── App.tsx              # 主组件
│   ├── main.tsx             # React 入口
│   └── index.css            # 全局样式 + Tailwind 4 @theme
├── scripts/
│   ├── build-electron.js    # esbuild 编译主进程
│   ├── launch-electron.js   # 启动脚本（修 ELECTRON_RUN_AS_NODE）
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

Vite 开发服务器 + Electron 窗口，修改代码自动热更新。

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