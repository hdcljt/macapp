# 打包发布指南

> 本文档说明如何打包 macOS、Windows 上的桌面应用，以及跨平台构建方案。

## 📦 打包命令速查

| 命令 | 用途 | 平台 |
|------|------|------|
| `npm run icon:generate` | 生成应用图标 | 任意 |
| `npm run build:mac` | 构建 macOS .dmg + .zip（需 Mac） | macOS |
| `npm run build:mac:universal` | 构建 macOS 通用包（Intel + Apple Silicon） | macOS |
| `npm run build:win` | 构建 Windows（默认 NSIS installer） | Windows |
| `npm run build:win:zip` | 构建 Windows 便携 ZIP（兼容旧版） | Windows |
| `npm run build:win:nsis` | 构建 Windows NSIS installer + 便携 ZIP（推荐） | Windows |
| `npm run build` | 构建当前平台 | 当前 |

---

## 🍎 方案一：GitHub Actions 自动构建（推荐 ✅）

**优点**：无需 Mac、自动化、产出 universal binary

### 首次配置

```bash
# 1. 提交代码到 GitHub
git init
git add .
git commit -m "feat: 初始化项目"
git branch -M main
git remote add origin https://github.com/your-team/macapp.git
git push -u origin main
```

### 触发构建

**方式 A：自动触发**
- 推送到 `main` 或 `develop` 分支
- 创建 `v*` 标签（如 `v0.1.0`）触发正式 Release

**方式 B：手动触发**
1. 进入 GitHub 仓库的 Actions 页面
2. 选择 "Build Desktop Apps"
3. 点击 "Run workflow"

### 下载产物

1. 进入 Actions → 选择运行记录
2. 滚动到 Artifacts 区域
3. 下载：
   - `macapp-macos-x64` - Intel Mac
   - `macapp-macos-arm64` - Apple Silicon Mac
   - `macapp-macos-universal` - 通用二进制（推荐）
   - `macapp-windows` - Windows 安装包

### 发布到 GitHub Release

```bash
git tag v0.1.0
git push origin v0.1.0
```

自动创建 GitHub Release，包含所有构建产物。

---

## 💻 方案二：本地 Mac 构建

如果你有一台 Mac，可以直接构建：

```bash
# 1. 安装依赖
npm install

# 2. 生成图标（macOS 上会生成 .icns）
npm run icon:generate

# 3. 构建
npm run build:mac              # x64 + arm64 单独包
npm run build:mac:universal    # 通用二进制（推荐）
```

产物在 `release/0.1.0/`：
- `算粒AI助手-0.1.0-x64.dmg` - Intel Mac
- `算粒AI助手-0.1.0-arm64.dmg` - Apple Silicon
- `算粒AI助手-0.1.0-universal.dmg` - 通用（任意 Mac）

---

## 🪟 方案三：本地 Windows 构建

```bash
# 推荐：NSIS 安装程序 + 便携 ZIP（已绕过 Defender EPERM）
npm run build:win:nsis

# 仅 ZIP（兼容旧打包方式）
npm run build:win:zip
```

### 产物说明

`release/0.1.0/` 目录：
- `算粒AI助手-0.1.0-x64-Setup.exe` - **NSIS 安装程序**（双击启动安装向导）
- `win-unpacked/` - 便携版目录
- `release/算粒AI助手-0.1.0-x64.zip` - 便携 ZIP 压缩包

### 常见问题：Windows Defender EPERM

`electron-builder` 26 在解压 Electron 二进制时会被 Windows Defender 锁定临时目录，抛出 `EPERM: rename` 错误。

**解决方案**（已封装在 `scripts/build-windows-installer.js`）：
1. 预先用 PowerShell `Expand-Archive` 解压 Electron 二进制到 `.electron-cache/electron`
2. `package.json` 配置 `"electronDist": ".electron-cache/electron"` 让 builder 跳过自动解压
3. 如果 NSIS `*.exe.tmp` 也被锁，用 PowerShell `Copy-Item` 复制为最终 `.exe`

如在 GitHub Actions 上构建，CI runner 无 Defender 干扰，可直接用 `npm run build:win`。

**注意**：Windows 上构建需要符号链接权限。如果遇到 `Cannot create symbolic link` 错误：

### 解决方法

**方法 A：以管理员身份运行**
```powershell
# PowerShell（管理员）
npm run build:win:nsis
```

**方法 B：开启开发者模式**
1. 设置 → 更新和安全 → 开发者选项
2. 开启 "开发人员模式"
3. 重新运行命令

**方法 C：使用 GitHub Actions**
直接在 Windows 上只做开发，Windows 包通过 GitHub Actions 构建。

---

## 🖼️ 自定义图标

修改 `build/icon.svg` 后重新生成：

```bash
npm run icon:generate
```

生成的文件：
- `build/icon.png` - 512x512，electron-builder 自动使用
- `build/icon.icns` - macOS 专用（仅 macOS 平台生成）
- `build/icon.ico` - Windows 专用
- `build/icon.iconset/` - macOS iconset 目录

### macOS 上手动生成 .icns

```bash
# macOS 上
npm run icon:generate
# 自动调用 iconutil 合成 .icns
```

---

## 🔐 代码签名（可选）

当前配置为**内部使用，无需签名**。如果要发布到 App Store 或对外发布：

### Apple 开发者账号

1. 注册 Apple Developer Program（$99/年）
2. 创建证书：
   - Developer ID Application
   - Developer ID Installer
3. 配置环境变量：
   ```bash
   export CSC_LINK=/path/to/certificate.p12
   export CSC_KEY_PASSWORD=your_password
   export APPLE_ID=your@email.com
   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx
   export APPLE_TEAM_ID=XXXXXXXXXX
   ```
4. 修改 `package.json`：
   ```json
   "mac": {
     "identity": "Developer ID Application: Your Name (TEAMID)",
     "hardenedRuntime": true,
     "gatekeeperAssess": true,
     "notarize": true
   }
   ```

### Windows 签名

需要 EV 代码签名证书（~$300-500/年）。配置方法类似。

---

## 🐛 常见问题

### Q1: macOS 打包失败 "Build for macOS is supported only on macOS"
electron-builder 不允许在 Windows 上直接构建 macOS。使用：
- GitHub Actions（推荐）
- 在 Mac 上本地构建

### Q2: Windows 打包失败 "Cannot create symbolic link"
权限问题。按上面方法解决。

### Q3: 下载 electron-builder-binaries 失败
配置镜像：
```bash
npm config set ELECTRON_BUILDER_BINARIES_MIRROR https://npmmirror.com/mirrors/electron-builder-binaries/
```

### Q4: 想要减小包体积
- 移除不用的依赖
- 压缩图片资源
- 使用 7-Zip 压缩

### Q5: 启动时 macOS 提示"无法验证开发者"
未签名的应用。解决方案：
- 用户右键 → 打开 → 仍要打开
- 或配置代码签名

### Q6: 想要自动更新
主流方案：[electron-updater](https://www.electron.build/auto-update)
需要配置 `publish` 字段 + 代码签名。

---

## 📊 打包产物对比

| 平台 | 格式 | 大小（约） | 用途 |
|------|------|-----------|------|
| macOS DMG | 磁盘镜像 | 100-150MB | 拖拽安装 |
| macOS ZIP | 压缩包 | 100-150MB | 手动解压 |
| macOS Universal | DMG | 180-250MB | 兼容 Intel + Apple Silicon |
| Windows EXE | 安装器 | 80-120MB | 一键安装（需 NSIS） |
| Windows DIR | 绿色版 | 150-200MB | 解压即用 |

---

## 🎯 建议

**MVP 阶段（内部测试）**：
- ✅ 仅用 GitHub Actions 自动构建
- ✅ 不签名、不公证
- ✅ 通过内部下载链接分发

**正式发布**：
- ✅ 配置 Apple 开发者签名
- ✅ Windows EV 代码签名
- ✅ 配置自动更新（electron-updater）
- ✅ 接入 CI/CD 完整流程
