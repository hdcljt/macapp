# 离线兜底页面 — 设计文档

日期：2026-08-22
主题：在已有「单 BrowserWindow + 多 WebContentsView」架构上，新增一个「离线兜底页面」作为 contentView 加载失败的回退视图（替代现有的 retry/error 路径），UI 与 deerflow agent-user 的 Assistant 页保持一致。

## 背景

算粒AI助手当前架构（[electron-webcontentsview-state-views-design.md](2026-08-20-electron-webcontentsview-state-views-design.md)）在 contentView 加载失败时按以下流程降级：

```
contentView.did-fail-load → retryView（重试中） → 重试用尽 → errorView（终态）
```

体验问题：

1. **降级视图信息密度低**：splash/retry/error 仅展示 logo + 一行文案 + 倒计时，无法传递产品能力信息，用户感知不到"这个 App 是什么、能做什么"。
2. **品牌断裂**：线上 URL 是 deerflow 的 Assistant 页（http://localhost:5195/agent-user/assistant），加载失败时直接退到无品牌纯色页，体验割裂。
3. **v0.1.0 已有可复用的离线 UI 资产**：v0.1.0 当时的主窗口本身就是一份"v0.1.0 风格的本地 UI"，并且 deerflow 的 Assistant 页是 v0.1.0 的"改进复刻版"——直接把 deerflow Assistant 页搬过来作为离线兜底，恰好等于把 v0.1.0 的"产品介绍页"复活。

因此本次需求：**新增一个离线兜底页面**，UI 与 deerflow agent-user Assistant 页一致，在 contentView 加载失败时直接展示（**不重试**），同时保留原有 retry/error 模式作为另一种配置选项。

## 目标

1. **失败即兜底**：contentView 加载失败时（`did-fail-load` 触发），直接切到离线兜底页，不进行 retry。
2. **UI 一致**：离线页 UI 与 `http://localhost:5195/agent-user/assistant` 页面在视觉与交互上保持一致（TopBar、AI 应用切换、功能区块、底部 Tab + 输入栏等）。
3. **样式原生**：使用 SCSS（不引入 tailwind），避免 CSS 框架大版本变更带来的样式回归。
4. **可切换**：通过 `config.jsonc` 的 `useOfflineFallback` 字段切换"离线兜底模式"与"原有 retry/error 模式"，**默认使用离线兜底模式**。
5. **架构隔离**：离线页作为一个独立的 vite 子项目（`offline-app/`），自包含 package.json，与根 electron-builder 工程解耦。
6. **可独立调试**：`npm run dev:offline` 单独跑 vite dev server 直接调试离线页 UI（与 electron 主进程解耦）。

## 设计

### 1. 架构与模块布局

#### 1.1 新增/修改文件清单

```
offline-app/                              ← 新增子项目（与 electron/ 平级）
├── package.json                          ← 独立依赖（vue / vite / sass / element-plus / pinia）
├── tsconfig.json
├── vite.config.ts                        ← base: './', outDir: '../dist-electron/offline-app'
├── index.html
└── src/
    ├── main.ts                           ← createApp + 挂载 + 引入全局样式
    ├── App.vue                           ← 顶部 nav + 主滚动区 + 底部输入
    ├── components/
    │   ├── TopBar.vue                    ← 从 deerflow AssistantTopBar.vue 移植
    │   ├── SideDrawer.vue                ← 从 deerflow AssistantSideDrawer.vue 移植（去掉 router 跳转）
    │   ├── AppCarousel.vue               ← 从 deerflow AssistantAppCarousel.vue 移植
    │   ├── FeatureSection.vue            ← 从 deerflow AssistantFeatureSection.vue 移植
    │   ├── FeatureCard.vue               ← 从 deerflow AssistantFeatureCard.vue 移植
    │   ├── BottomTabBar.vue              ← 从 deerflow AssistantBottomTabBar.vue 移植
    │   └── InputBar.vue                  ← 从 deerflow AssistantInputBar.vue 移植
    ├── data/
    │   └── assistantFeatures.ts          ← aiApps / featureSections / bottomTabs / mockAgents
    ├── stores/
    │   └── ui.ts                         ← Pinia store：drawer 开关 + 当前激活 tab（纯 UI 状态）
    └── styles/
        ├── variables.scss                ← 颜色/间距变量
        └── global.scss                   ← app-bg、.glass-card 等全局类

electron/
├── main.ts                               ← 改：增加 offlineView + useOfflineFallback 分支
└── config.ts                             ← 改：增加 useOfflineFallback 字段

scripts/
└── (无需改动；offline-app 由 vite build 直接写到 dist-electron/offline-app/)

config.jsonc                             ← 改：增加 useOfflineFallback 字段
README.md                                ← 改：新增「🛡️ 离线兜底页面」章节
```

#### 1.2 模块依赖关系

```
根 package.json scripts
├── "dev:offline": "npm --prefix offline-app run dev"          ← 独立调试 vite dev server
├── "build:offline": "npm --prefix offline-app install && npm --prefix offline-app run build"
└── "build": "npm run build:electron && npm run build:offline" ← 调整顺序：先 esbuild 主进程，再 vite 离线页

offline-app/vite.config.ts
├── base: './'                                                 ← 关键：让 index.html 用相对路径加载 ./assets/*
├── build.outDir: '../dist-electron/offline-app'              ← 产物直接落到 electron 的运行目录
└── build.emptyOutDir: true                                    ← 清空旧产物

electron/main.ts createMainWindow
├── loadingView = createView('splash.html')
├── retryView   = createView('retry.html')                     ← 仅 useOfflineFallback=false 时使用
├── errorView   = createView('error.html', { targetUrl })      ← 仅 useOfflineFallback=false 时使用
├── offlineView = useOfflineFallback ? createView('offline-app/index.html') : null  ← 新增
└── contentView = createUrlView(TARGET_URL)

contentView.webContents.on('did-fail-load')
├── if (useOfflineFallback && offlineView) → showOnly(offlineView); return;   ← 新分支
└── 原 retry/error 逻辑保留（useOfflineFallback=false 时走原路径）
```

#### 1.3 状态机

新增状态列「offlineView」：

| 状态 | loadingView | retryView | errorView | **offlineView**（新增） | contentView |
|------|-------------|-----------|-----------|-----------|-------------|
| 启动（初始加载） | ✅ 可见 | ❌ | ❌ | ❌ | 加载中（被覆盖） |
| 加载成功 | ❌ | ❌ | ❌ | ❌ | ✅ 可见 |
| **加载失败（离线模式，默认）** | ❌ | ❌ | ❌ | **✅ 可见** | ❌ |
| 首次失败（在线模式） | ❌ | ✅ 显示 `正在重试 1/3…` | ❌ | ❌ | 5s 后重载 |
| 重试耗尽（在线模式） | ❌ | ❌ | ✅ 可见 | ❌ | ❌ |
| 错误页点重试（在线模式） | ✅ 可见 | ❌ | ❌ | ❌ | reset + 重载 |

**关键行为差异**：离线模式下 `did-fail-load` **只触发一次** `showOnly(offlineView)`，不再走 retry 流程，也不暴露"重试"按钮（v0.1.0 的 InputBar 只有语音/拍照/更多按钮，没有重试入口）。

### 2. offline-app 子项目结构

#### 2.1 package.json 依赖

```jsonc
{
  "name": "macapp-offline",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "vue": "^3.5.13",
    "pinia": "^3.0.2",
    "element-plus": "^2.9.10",
    "@element-plus/icons-vue": "^2.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "6.0.5",
    "typescript": "^5.8.3",
    "vue-tsc": "^2.2.10",
    "vite": "8.0.16",
    "sass": "^1.88.0"
  }
}
```

**依赖选择理由**：
- 与 deerflow `agent-user` 的依赖版本对齐（直接复用 .vue 组件结构）
- **不引入** `vue-router` / `axios` / `@agent-infra/shared`（离线场景无路由、无后端、无跨包类型共享）
- **不引入** tailwindcss（用户明确要求原生 SCSS）

#### 2.2 vite.config.ts

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  base: './',                                  // 关键：相对路径，file:// 加载时能找到 ./assets/*
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist-electron/offline-app',   // 产物直接落到 electron 运行时目录
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    port: 5195,                                // 可选：与 deerflow agent-user dev server 同端口，方便对比 UI
    strictPort: true,
  },
});
```

#### 2.3 入口与全局挂载

`offline-app/src/main.ts`：
```ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import './styles/global.scss';

const app = createApp(App);
app.use(createPinia());
app.use(ElementPlus);
app.mount('#app');
```

`offline-app/src/App.vue` 直接参考 deerflow `AssistantPage.vue` 的结构（TopBar + SideDrawer + 主滚动区 + BottomTabBar + InputBar），去掉所有 router-view、去掉 AgentSection（离线场景无登录态、无 agent 列表）。

#### 2.4 离线简化策略

| deerflow 中的能力 | 离线页处理方式 |
|---|---|
| `vue-router` 跳 `/agents/<name>/chat` | 删：所有跳转改占位 `console.log` 或 noop |
| `usePublicAgentList` / `usePrivateAgentList` Pinia store（axios 拉 agent 列表） | 删：换成 `data/assistantFeatures.ts` 里的 `mockAgents.public` 静态数组（4-6 个假 agent） |
| `useUserStore`（登录态） | 删：UI 中 SideDrawer 直接显示「未登录」+ 占位登录入口 |
| Element Plus 全量引入 | 缩：只引入 `ElDrawer`、`ElButton`、`ElIcon`，按需 `unplugin-vue-components` 或全量 `app.use(ElementPlus)`（离线页体积不敏感，选全量简单） |
| 真实后端 API | 不引入 axios；任何 fetch 调用都去掉 |

数据 mock（`data/assistantFeatures.ts`）：
```ts
export const aiApps = [/* 从 deerflow 拷 */];
export const featureSections = [/* 从 deerflow 拷 */];
export const bottomTabs = [/* 从 deerflow 拷 */];
export const mockAgents = {
  public: [
    { name: '写邮件助手', icon: '✉️', desc: '一键生成专业邮件', from: 'public' },
    { name: '代码评审', icon: '🔍', desc: '智能分析代码质量', from: 'public' },
    { name: '翻译官', icon: '🌐', desc: '多语言互译', from: 'public' },
    { name: '会议纪要', icon: '📝', desc: '自动整理会议要点', from: 'public' },
  ],
  // private 在离线模式为空（不显示"我的智能体"section）
};
```

`AgentSection.vue` 在离线版**不挂载**（deerflow 中是 `v-if="userStore.isLoggedIn"` 触发的，离线场景恒为未登录）。

### 3. 构建集成

#### 3.1 根 package.json scripts 调整

```jsonc
{
  "scripts": {
    "dev:offline": "npm --prefix offline-app run dev",
    "build:offline": "npm --prefix offline-app install --no-audit --no-fund && npm --prefix offline-app run build",
    "build:electron": "node scripts/build-electron.js",
    "build": "npm run build:electron && npm run build:offline"
  }
}
```

构建顺序说明：
- `build:electron` 先：编译 main.ts → dist-electron/main.js（不依赖 offline-app）
- `build:offline` 后：vite build → dist-electron/offline-app/{index.html, assets/*}（空目录可写）
- 两者互不依赖，但顺序固定让产物最终一致
- **首次构建约束**：`vite.config.ts` 设了 `emptyOutDir: true`，要求父目录 `dist-electron/` 已存在；首次构建必须先跑 `build:electron` 创建目录，再跑 `build:offline`。后续构建顺序无所谓（目录已存在）

#### 3.2 scripts/build-electron.js 不需改

vite build 直接把产物写到 `dist-electron/offline-app/`，与 esbuild 输出的 `main.js`、`preload.js` 同级。`createView('offline-app/index.html')` 直接 `path.join(__dirname, 'offline-app/index.html')` 即可（与 `createView('splash.html')` 同理）。

### 4. 主进程集成

#### 4.1 config.ts 新增字段

```ts
export interface AppConfig {
  // ... 现有 10 字段 ...
  /** 是否使用离线兜底页面替代 retry/error 视图。默认 true */
  useOfflineFallback: boolean;
}
```

校验逻辑：
```ts
if (!('useOfflineFallback' in o)) {
  errors.push('字段 useOfflineFallback 缺失');
} else if (typeof o.useOfflineFallback !== 'boolean') {
  errors.push(`useOfflineFallback 必须是 boolean (实际: ${JSON.stringify(o.useOfflineFallback)})`);
}
```

日志输出（在 `loadConfig` 末尾加一行）：
```ts
log.info(`离线兜底: ${validated.useOfflineFallback ? '启用' : '禁用（使用 retry/error 模式）'}`);
```

#### 4.2 main.ts createMainWindow 改动

```ts
function createMainWindow(config: LoadedConfig) {
  const OFFLINE_PAGE = 'offline-app/index.html';
  const useOffline = config.useOfflineFallback;

  // ... 现有 mainWindow 创建 ...

  loadingView = createView('splash.html');
  if (useOffline) {
    // 离线模式：只创建 loadingView + contentView + offlineView
    offlineView = createView(OFFLINE_PAGE);
    retryView = null;
    errorView = null;
  } else {
    // 原 retry/error 模式
    retryView = createView('retry.html');
    errorView = createView('error.html', { targetUrl: TARGET_URL });
    offlineView = null;
  }
  contentView = createUrlView(TARGET_URL);

  showOnly(loadingView);
  mainWindow.show();

  // contentView 加载成功 / 失败的分支
  contentView.webContents.on('did-fail-load', (_e, code, desc, url) => {
    loadFailed = true;
    log.error(`content view did-fail-load: ${code} ${desc} url=${url}`);

    if (useOffline && offlineView) {
      // 离线模式：直接兜底，不重试
      log.warn('falling back to offline page (no retry)');
      showOnly(offlineView);
      return;
    }

    // 原 retry/error 逻辑（useOffline=false）
    if (retryCount < MAX_RETRIES) {
      retryCount += 1;
      // ... 重试逻辑 ...
    } else {
      showOnly(errorView);
    }
  });

  // render-process-gone：两种模式都走 retry 流程（offline 模式仍走 retry，offline 模式最终切 offlineView）
  contentView.webContents.on('render-process-gone', (_e, details) => {
    log.error(`render-process-gone: ${JSON.stringify(details)}`);
    if (!contentView || contentView.webContents.isDestroyed()) return;
    if (retryCount < MAX_RETRIES) {
      retryCount += 1;
      // ... 重试逻辑 ...
    } else {
      if (useOffline && offlineView) {
        log.warn('render-process-gone retry exhausted, falling back to offline page');
        showOnly(offlineView);
      } else {
        log.error(`gave up after ${MAX_RETRIES} retries, switching to error view`);
        showOnly(errorView);
      }
    }
  });

  // ... 其余逻辑（will-navigate / setWindowOpenHandler / resize / closed）保持不变 ...

  // mainWindow.on('closed') 清空所有 view 引用
}
```

`showOnly` 函数改动（兼容 retry/error 可能为 null）：
```ts
function showOnly(view: WebContentsView | null) {
  loadingView?.setVisible(view === loadingView);
  retryView?.setVisible(view === retryView);     // 离线模式下 retryView = null，null?.setVisible 安全短路
  errorView?.setVisible(view === errorView);
  offlineView?.setVisible(view === offlineView); // 新增
  contentView?.setVisible(view === contentView);
}
```

### 5. 配置文件变更

`config.jsonc` 增加字段：

```jsonc
{
  // ... 现有 10 字段 ...

  // 是否使用离线兜底页面作为 contentView 加载失败的回退视图。
  // true（默认）：失败直接切到离线页（v0.1.0 风格 UI），不重试
  // false：使用原有 retry → error 流程（重试 N 次后显示错误页）
  "useOfflineFallback": true
}
```

### 6. 关键决策与权衡

#### 6.1 为什么用 Vite + Vue 3 而不是 React + tailwind

- v0.1.0 当时确实有 React+tailwind 版本，但用户**明确要求避开 tailwind**（大版本变更样式回归）
- deerflow agent-user 的 Assistant 页是 v0.1.0 的"改进复刻版"，本身就是 Vue 3 + SCSS
- 直接复用 deerflow 的 .vue 组件结构，比从 React+tailwind 翻译成 Vue+SCSS 工作量小一个量级

#### 6.2 为什么离线页用 `dist-electron/offline-app/` 目录而不是打包成单 HTML

- 走 `vite-plugin-singlefile` 会把所有 CSS/JS 内联到单 HTML，v0.1.0 的 index.css 较大（Tailwind 编译产物），内联后 HTML 体积难看
- 多文件目录 + `base: './'` 是 WebContentsView 用 file:// 加载的标准做法，子资源路径自动正确解析

#### 6.3 为什么默认 `useOfflineFallback: true`

- 用户原话："默认使用离线模式"
- 默认离线兜底意味着用户拿到的体验更接近"App 始终有一个可用的界面"，符合桌面应用降级原则
- 想保留 retry/error 行为的运维只需把字段设为 false

#### 6.4 为什么不重试

- 用户原话："作为在线地址加载失败的兜底，不重试"
- 简化状态机：失败即切离线页，避免 retry 期间显示 retryView 再次失败再切离线页的多步切换
- 离线页本身没有"重试"按钮，符合"兜底=终态"的语义

#### 6.5 离线页不放"重新连接"按钮的理由

- 用户原话强调"不重试"，加按钮违背语义
- 后续如需支持后台探活+自动切回线上，作为独立功能再做（详见 § 7 未来工作）

### 7. 未来工作（本次明确不做）

1. **后台定时探活**：离线模式下主进程每 30s 探测一次 contentView 是否可访问，恢复后自动切回 contentView。
2. **离线页"重新连接"按钮**：InputBar 加按钮触发 IPC `retry:request`，主进程 reload contentView，成功则切回 contentView。
3. **离线页接入真实 agent 列表**：若将来想给离线页也展示真实的"我的智能体"，需要引入 axios + 真实 store。
4. **localStorage 缓存**：离线模式下展示最近一次成功加载时的 agent 列表快照。
5. **国际化**：当前离线页文案用中文，未来可抽出 i18n key。

### 8. 验证

#### 8.1 离线页独立调试

```bash
npm run dev:offline
# 浏览器访问 http://localhost:5195/
# 验证：UI 与 http://localhost:5195/agent-user/assistant 一致
# 验证：mock 数据正常展示（无 console error / 无 404）
```

#### 8.2 主流程集成验证

```bash
npm run build:offline
ls dist-electron/offline-app/
# 预期输出：
#   index.html
#   assets/index-xxxxxx.js
#   assets/index-xxxxxx.css

npm run build:electron && npm start
# 预期：contentView 加载线上 URL → loadingView 覆盖 → 成功切 contentView
```

#### 8.3 离线模式降级验证

修改 `config.jsonc` 中 `targetUrl` 为一个无法访问的地址（如 `http://localhost:9999/`），`useOfflineFallback: true`：

```bash
npm run build:offline && npm run build:electron && npm start
# 预期：
#   1. loadingView 显示 1~2s
#   2. contentView 加载失败 → 直接切到 offlineView（不重试）
#   3. 离线页 UI 与 deerflow Assistant 页一致
```

#### 8.4 retry/error 模式保留验证

`config.jsonc` 设 `useOfflineFallback: false`，`targetUrl` 同上：

```bash
npm run build:electron && npm start
# 预期：
#   1. retryView 显示 "正在重试 1/3…"
#   2. 间隔 5s 后再尝试，最多重试 3 次
#   3. 用尽后切 errorView（行为与 v0.5.6 一致，向后兼容）
```

#### 8.5 回归验证

`useOfflineFallback: false` + 正常 `targetUrl`：

```bash
npm run build:electron && npm start
# 预期：contentView 加载成功，正常显示线上 URL；行为与 v0.5.6 完全一致
```
