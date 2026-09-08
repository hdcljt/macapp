# macapp 集成 opencode 本地 AI 编程能力方案

- 版本：v1.0（草案）
- 日期：2026-08-25
- 状态：待评审
- 适用：算粒AI助手（Electron 43 桌面壳，v0.6.2）

---

## 1. 背景与目标

### 1.1 背景

当前 macapp 是一个"壳 + 远程内容"架构的桌面应用：主界面加载后端 agent-user 页面，离线时有本地 Vue 兜底页。UI 中已有"写代码"入口（`offline-app` 的 FeatureSection / BottomTabBar），但为占位，真实能力依赖后端网页。

要让桌面客户端具备"写 AI 代码"能力，优先考虑**复用成熟的开源 Coding Agent（opencode / Pi Agent）**，而非自研。

### 1.2 目标

1. 用户点击"写代码"后，能在 macapp 内直接使用 AI Coding Agent 处理**本地代码仓库**（理解、修改、运行、修复）。
2. 不改变"壳 + Web 内容"的总体架构，最小化开发成本。
3. 兼容内网分发、ad-hoc 签名、无公证的现状，不引入新的签名/分发复杂度。
4. 为后续演进（远程服务化、账号体系对接、TUI 增强）预留扩展点。

### 1.3 非目标（本期不做）

- 不捆绑 CLI 进安装包（原因见 2.2）。
- 不做 TUI 终端嵌入（`xterm.js` + PTY）。
- 不改造后端 agent-user 在线页面（远程页面的"写代码"行为由后端自行演进，本期只覆盖本地可控的入口）。

---

## 2. 核心决策与选型

### 2.1 引擎选择：opencode

| 对比项 | opencode（sst） | Pi Agent | Claude Code / Codex CLI |
|---|---|---|---|
| 开源 | 是（165k+ star） | 是（93k+ star） | 否（闭源/厂商绑定） |
| 内置 Web UI | **有**（`opencode web`） | 终端为主 | 无 |
| 服务模式 | **有**（`opencode serve`，HTTP API） | 有限 | 有限 |
| 模型接入 | 75+ provider，支持自定义 | 多 provider | 绑定自家 |
| 多终端同步 | `opencode attach` | 无 | 无 |

**结论**：opencode 同时具备"本地服务 + 官方 Web UI + 多模型"，与本方案所需的"Web 形态嵌入"最契合，选为引擎。Pi Agent 作为备选（若其 serve/Web 能力在评审时已成熟，可无痛切换，因为接入层是进程抽象，见 4.3）。

### 2.2 形态选择：本地服务 + Web UI 嵌入（而非捆绑安装 / 唤起 TUI）

**选 Web 形态，不选"安装时捆绑 + 唤起 TUI 客户端"**，原因：

| 维度 | 捆绑 + TUI（用户原始提案） | 按需安装 + Web UI（本方案） |
|---|---|---|
| 安装包体积 | +30~80MB（x64/arm64 双二进制） | 不变（按需下载） |
| 签名链 | 捆绑二进制需处理 quarantine/Gatekeeper，ad-hoc 签名下风险高 | 安装器自己处理签名校验，app 无感 |
| 平台差异 | macOS/Windows 各一套终端唤起逻辑 | 统一（都走 Web 渲染） |
| 内网分发 | GitHub 下载源与内网矛盾，安装源难定制 | 安装源可配置（内网镜像） |
| UI 集成 | 弹终端割裂 / xterm.js 开发量大 | 一个 WebContentsView，与现有架构同构 |
| 版本跟进 | 随 app 更新，滞后 | 独立安装器更新，不受 app 版本约束 |
| UX | 多一步"打开终端"的割裂感 | 应用内一体化 |

### 2.3 安装策略：按需引导安装（first-use），不捆绑

- **首次点击"写代码"** → 主进程检测 `opencode` 是否可用。
- 未安装 → 展示引导 UI（进度 + 日志），从**可配置的安装源**下载安装（默认官方脚本，内网可配镜像）。
- 已安装 → 直接启动服务。

---

## 3. 总体架构

```
┌─────────────────────────── macapp (Electron 主进程) ───────────────────────────┐
│                                                                                │
│  codingAgent 模块                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │ ① detect()  检查 opencode 是否已安装                                    │   │
│  │ ② install() 引导安装（可配置源）→ 校验可执行                            │   │
│  │ ③ spawn()   opencode web --port P --hostname 127.0.0.1  (cwd=项目目录)  │   │
│  │ ④ health    等待端口就绪 / 进程退出监听 / 重启                           │   │
│  │ ⑤ lifecycle app 退出 / 窗口关闭 / view 隐藏时回收                        │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│   Views 管理：loading/retry/error/offline/content/【coding】                    │
│   IPC：coding:open / coding:close / coding:status / coding:install ...         │
└────────────────────────────────────────────────────────────────────────────────┘
                          │ spawn (cwd=用户项目目录)
                          ▼
               ┌─────────────────────┐
               │  opencode web       │  ← 进程由主进程管理，退出时回收
               │  http://127.0.0.1:P │
               └─────────────────────┘
                          │ WebContentsView 加载
                          ▼
               ┌─────────────────────┐
               │  opencode 官方 Web UI │  ← sandbox:false（本地可信 URL）
               └─────────────────────┘
```

数据流（用户点击"写代码"）：

```
offline 页(Vue) ──IPC──▶ 主进程 codingAgent ──spawn──▶ opencode web
      ▲                                                            │
      │                        WebContentsView 切到 codingView    │
      └────────────────────────────────────────────────────────────┘
```

---

## 4. 详细设计

### 4.1 模块划分

| 文件 | 职责 |
|---|---|
| `electron/codingAgent.ts`（新增） | opencode 检测/安装/启停/健康检查/生命周期，独立可测试 |
| `electron/main.ts`（改造） | 新增 `codingView` 的创建与显示切换；注册 coding IPC |
| `electron/preload.ts`（改造） | 暴露 `window.electronAPI.coding.*` API |
| `electron/config.ts`（改造） | `AppConfig` 增加 codingAgent 字段 + 校验 + 迁移 |
| `offline-app/src/...`（改造） | "写代码"卡片点击 → `electronAPI.coding.open()`；安装进度 UI |
| `electron/codingInstall.ts`（可选） | 安装器（下载/解压/权限），或并入 codingAgent.ts |

### 4.2 安装检测与引导

```ts
// codingAgent.ts 核心接口（示意）
interface CodingAgent {
  detect(): Promise<{ installed: boolean; version?: string; binPath?: string }>;
  install(opts: { source: string }): Promise<{ ok: boolean; message: string }>;
  open(dir: string): Promise<{ ok: boolean; port: number; url: string }>;
  close(): Promise<void>;
  status(): Promise<CodingStatus>;
  on('exit' | 'error', cb): void;
}
```

检测逻辑：
- 查找顺序：配置指定 `binPath` → `where opencode` / `which opencode` → 常见安装位置（`~/.opencode/bin` 等）。
- 验证：`opencode --version` 能执行且退出码为 0。

安装引导（首用流程）：
1. 展示引导页（复用 offline-app，新增一个 dialog 或页面），含安装日志流。
2. 默认安装源 `https://opencode.ai/install`（官方脚本）；**内网环境可配 `npm` 镜像**（`npm i -g opencode-ai`）或私有二进制 URL。
3. 安装完成 → 再次 `detect()` 校验 → 继续 `open()` 流程。
4. 安装失败 → 展示错误与手动安装指引（复制命令让用户自己装）。

### 4.3 主进程 codingAgent 模块

- **启动服务**：`spawn(binPath, ['web', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: projectDir, stdio: 'pipe' })`。
  - 工作目录（`cwd`）来自：用户在"写代码"入口选择的目录 / 配置项默认目录。opencode 会在该目录下执行代码操作。
  - `port`：优先用配置值（默认 `4296`，避开 opencode 默认 4096 以降低冲突概率）；端口被占用时自动探测空闲端口。
  - `--hostname 127.0.0.1`：**只绑定回环地址**，不暴露到局域网。
- **健康检查**：`stdout` 监听 + 轮询 `http://127.0.0.1:<port>`（GET `/`，2xx 即就绪），就绪后才切 view。
- **进程回收**：view 关闭、窗口关闭、`before-quit` 时 `kill()`；进程异常退出 → 回传 `coding:status` 给 UI，offline 页提示重试。
- **单例**：同一时刻仅一个 codingView / 一个 opencode 进程；重复点击 `open` 直接切到已有 view。

### 4.4 IPC 接口与 preload 扩展

`preload.ts` 增加命名空间（沿用现有 `contextBridge.exposeInMainWorld('electronAPI')` 模式）：

```ts
coding: {
  open: (dir?: string) => ipcRenderer.invoke('coding:open', dir),
  close: () => ipcRenderer.invoke('coding:close'),
  status: () => ipcRenderer.invoke('coding:status'),
  install: (source?: string) => ipcRenderer.invoke('coding:install'),
  onStatus: (cb) => { /* 订阅 coding:status 推送，返回退订函数 */ },
  onInstallProgress: (cb) => { /* 订阅安装日志/进度 */ },
  chooseDir: () => ipcRenderer.invoke('dialog:choose-directory'), // 复用主进程 dialog
}
```

`main.ts` 在 `registerIpcHandlers()` 内新增一组 `coding:*` handler（保持"启动时一次性注册"模式，防止 macOS activate 重复注册泄漏）。

### 4.5 View 管理改造

在现有 `showOnly` / `allViews` 中纳入新 view（与 contentView 同级，全窗口覆盖）：

```ts
let codingView: WebContentsView | null = null;

function createCodingView(url: string): WebContentsView {
  // 复用 createUrlView 的 webPreferences（sandbox:false，本地可信 URL），
  // 但 preload 保持挂载以支持 future 增强；绑定独立的导航白名单（见 4.6）。
}
```

切换时机：
- 用户点击"写代码" → `showOnly(codingView)`（就绪前可显示 offline 页的 loading 状态）。
- 关闭 codingView（UI 返回按钮 / 关闭事件） → 回到 offlineView（或 contentView，若在线）。
- 隐藏 codingView 时**不杀 opencode 进程**（保留会话，再次打开秒切）；窗口关闭 / app 退出时回收（见 4.8）。

### 4.6 导航安全白名单

- codingView 独立绑定 `will-navigate` / `setWindowOpenHandler`：
  - 允许导航：`http://127.0.0.1:<port>/*`（本机 opencode Web UI，仅本会话启动的端口）。
  - 其余导航 `preventDefault`；`https:` 外链走 `shell.openExternal`（复用现有 handler 逻辑）。
- 不并入 contentView 的 `allowedOriginPrefix`，避免污染在线页白名单。

### 4.7 配置项扩展（config.jsonc）

新增字段（全部可选、带默认值，`validateConfig` 增加校验，缺失字段沿用现有"从 bundled 补齐"迁移机制）：

```jsonc
"codingAgent": {
  "enable": true,          // 总开关，false 时 UI 隐藏"写代码"入口
  "binPath": "",           // 自定义 opencode 可执行文件路径（空=自动检测）
  "installSource": "",     // 自定义安装源（官方脚本 / npm 镜像 / 私有二进制 URL）
  "port": 4296,            // 固定端口，占用时自动探测
  "defaultDir": ""         // 默认工作目录（空=每次让用户选择）
}
```

`AppConfig` 接口、`validateConfig`、迁移补齐逻辑同步扩展。

### 4.8 生命周期与清理

| 事件 | 行为 |
|---|---|
| 用户关闭 codingView | 隐藏 view，保留进程与会话 |
| 主窗口 `closed` | `codingView = null`，不立即杀进程（保留到 app 退出） |
| `before-quit` | `codingAgent.close()` → kill opencode 进程 |
| opencode 进程异常退出 | 推送 `coding:status`，UI 提示重试；view 切回 offline 页 |
| 端口被占用（非本 app 启动） | 提示用户端口冲突，可换端口重试 |
| 磁盘/TCC 权限不足（工作目录不可写） | 提示用户授权（macOS 桌面/文档/下载目录需 TCC） |

### 4.9 日志与错误处理

- 复用现有 `logger`（`main.log`）：记录 detect/install/spawn/exit/端口探测全过程。
- opencode 进程 `stdout/stderr` 接回 logger（滚动 buffer，仅最近 N 行保留用于排障）。
- 所有 UI 可感知的错误都有用户可读文案 + 操作指引（对齐现有 offline 页错误风格）。

### 4.10 安全基线

1. 服务仅绑定 `127.0.0.1`，不暴露局域网。
2. codingView 只加载本会话 `http://127.0.0.1:<port>`，导航白名单最小化。
3. 安装源 / 二进制校验：内网私有源需 HTTPS；官方源不做额外校验（信任官方渠道），后续可加 SHA256 校验清单。
4. opencode 的模型凭据（API Key）存于用户本机 `~/.opencode` 或 `~/.config/opencode`，app 不读取、不传输；是否对接统一账号体系属开放问题（第 7 节）。
5. 工作目录选择用原生 `dialog.showOpenDialog({ properties: ['openDirectory'] })`，杜绝任意路径注入。

---

## 5. 落地里程碑

### M1 原型验证（0.5 ~ 1 天）

- 手动安装 opencode，`opencode web` 手动验证 Web UI 可用。
- macapp：新增 `codingView` 加载 `http://127.0.0.1:4296`，主进程手动 spawn + IPC `coding:open/close`。
- 目标：证明"壳 + 本地 Web"跑通，产出截图给评审。

### M2 完整功能（3 ~ 5 天）

- codingAgent 模块完整实现（detect/install/spawn/health/lifecycle）。
- 首用引导安装 UI + 安装源配置化（内网镜像）。
- preload API、offline 页"写代码"入口、工作目录选择、日志、错误提示。
- config.jsonc 字段 + 校验 + 迁移；导航白名单；单例与会话保持。

### M3 增强（可选，视评审）

- opencode 版本提示 / 自更新（复用现有 updater 的思路但独立于 app 更新）。
- 在线页（contentView）的"写代码"入口：后端页面通过 deep link（如 `suanli://coding?dir=...`）唤起本地服务。
- 服务端统一认证代理（公司模型网关接入 opencode 自定义 provider）。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| opencode Web UI 功能弱于 TUI（会话/文件预览受限） | 用户体验打折 | M1 原型阶段用真实场景验证；不足则 M3 评估 xterm.js 或 `opencode attach` 形态 |
| 内网无法访问 opencode 安装源 / 模型 API | 功能不可用 | 安装源配置化（内网镜像）；模型接入走公司网关（自定义 provider） |
| 端口冲突 / 多实例 | 服务起不来 | 自动探测空闲端口；单例 view；冲突时明确提示 |
| macOS TCC 权限（工作目录不可写） | agent 无法改代码 | 原生目录选择 + 首次授权引导；明确错误文案 |
| opencode 版本升级破坏兼容 | CLI 参数变化 | spawn 参数集中封装；固定验证版本；升级走独立安装器可控 |
| 用户误用（让 agent 执行危险命令） | 安全隐患 | 依赖 opencode 自身的确认机制；后续可加命令审计（stdout 转发 logger） |
| 进程残留（崩溃/强制退出后 opencode 未回收） | 端口被僵尸进程占用 | `before-quit` 回收 + 启动时探测端口归属 |

---

## 7. 待确认问题（评审需拍板）

1. **模型 provider 与计费**：用户自带 Key（`opencode auth login`）还是公司网关统一鉴权？
2. **内网安装源**：官方脚本、内网 npm 镜像、还是私有二进制仓库？（影响 installSource 默认值）
3. **"写代码"的产品语义**：只处理用户主动选择的本地目录，还是也要覆盖在线页面场景（需后端配合 deep link）？
4. **是否要 Windows 版本同步**：项目有 win 构建，本方案在 Windows（NSIS）下同样成立，但优先顺序需确认。
5. **UI 入口位置**：offline 页 FeatureSection 卡片 + BottomTabBar 的 code tab 是否都接入？

---

## 8. 后续演进（非本期）

- **远程化**：opencode serve 部署到服务器，macapp 直接加载远程 Web UI（脱离"本地安装 CLI"约束），架构不变。
- **账号体系**：服务端代理统一认证 / 计费 / 审计。
- **TUI 增强**：若 Web UI 不够，嵌入式终端（node-pty + xterm.js）或 `opencode run --attach` 一次性任务模式。
- **自有前端**：基于 opencode HTTP API 自研 coding 页面（当前 Web UI 是官方内置，接口已开放）。
