# Offline Fallback Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Vite + Vue 3 + SCSS "offline fallback page" that is shown when `contentView` fails to load the configured target URL. The page UI mirrors deerflow `agent-user`'s Assistant page. Default behavior is fallback (no retry); `config.jsonc` can switch back to the legacy retry/error flow.

**Architecture:** A new `offline-app/` sub-project (independent Vite project with its own `package.json`) is built by Vite directly into `dist-electron/offline-app/`. Electron main process adds a 5th `WebContentsView` (`offlineView`) that is shown on `did-fail-load` when `config.useOfflineFallback === true` (default). When `false`, behavior is identical to v0.5.6 (retry → error). The page itself strips router/axios/Pinia-network stores from the deerflow source and replaces them with mock data + a tiny UI-only Pinia store.

**Tech Stack:** Vue 3.5 + `<script setup lang="ts">`, Vite 8, Pinia 3, Element Plus 2.9 + `@element-plus/icons-vue`, Sass 1.88, TypeScript 5.8. No Tailwind. No vue-router. No axios.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `offline-app/package.json` | CREATE | Standalone deps (vue/vite/pinia/element-plus/sass) |
| `offline-app/tsconfig.json` | CREATE | TS config for the sub-project |
| `offline-app/vite.config.ts` | CREATE | `base: './'` + `outDir: '../dist-electron/offline-app'` |
| `offline-app/index.html` | CREATE | Vite entry HTML |
| `offline-app/src/main.ts` | CREATE | `createApp` + Pinia + Element Plus + global styles |
| `offline-app/src/App.vue` | CREATE | Layout: TopBar + main scroll + BottomTabBar + InputBar |
| `offline-app/src/components/TopBar.vue` | CREATE | Port of `AssistantTopBar.vue` |
| `offline-app/src/components/SideDrawer.vue` | CREATE | Port of `AssistantSideDrawer.vue` (no router) |
| `offline-app/src/components/AppCarousel.vue` | CREATE | Port of `AssistantAppCarousel.vue` |
| `offline-app/src/components/FeatureSection.vue` | CREATE | Port of `AssistantFeatureSection.vue` |
| `offline-app/src/components/FeatureCard.vue` | CREATE | Port of `AssistantFeatureCard.vue` |
| `offline-app/src/components/BottomTabBar.vue` | CREATE | Port of `AssistantBottomTabBar.vue` |
| `offline-app/src/components/InputBar.vue` | CREATE | Port of `AssistantInputBar.vue` |
| `offline-app/src/data/assistantFeatures.ts` | CREATE | `aiApps` + `featureSections` + `bottomTabs` + `mockAgents` |
| `offline-app/src/stores/ui.ts` | CREATE | Pinia: `drawerOpen` + `activeTabId` (UI-only state) |
| `offline-app/src/styles/variables.scss` | CREATE | Color/spacing tokens |
| `offline-app/src/styles/global.scss` | CREATE | `.app-bg`, `.glass-card`, scrollbar, base |
| `package.json` (root) | MODIFY | Add `dev:offline` / `build:offline`; reorder `build` |
| `electron/config.ts` | MODIFY | Add `useOfflineFallback` field + validation + log |
| `electron/main.ts` | MODIFY | Conditionally create `offlineView`; branch `did-fail-load` + `render-process-gone`; `showOnly` null-safe |
| `config.jsonc` | MODIFY | Add `useOfflineFallback: true` example field |
| `README.md` | MODIFY | New "🛡️ 离线兜底页面" section |

## Task Dependency Graph

```
Task 1 (offline-app 脚手架)            ← standalone
        ↓
Task 2 (data + stores + styles)        ← standalone
        ↓
Task 3 (8 个 .vue 组件移植)             ← depends on Task 1, 2
        ↓
Task 4 (App.vue + main.ts)             ← depends on Task 3
        ↓
Task 5 (dev 调试 + 视觉对比)             ← depends on Task 4
        ↓
Task 6 (vite build 验证产物)             ← depends on Task 5
        ↓
Task 7 (根 package.json scripts)        ← standalone (依赖 Task 6 验证通过)
        ↓
Task 8 (config.ts + config.jsonc)       ← standalone
        ↓
Task 9 (main.ts 集成)                   ← depends on Task 8
        ↓
Task 10 (集成验证 5 场景)                ← depends on Task 7, 9
        ↓
Task 11 (README 文档)                   ← depends on Task 10
```

---

## Task 1: offline-app 脚手架（package.json + tsconfig + vite.config + index.html）

**Files:**
- Create: `offline-app/package.json`
- Create: `offline-app/tsconfig.json`
- Create: `offline-app/vite.config.ts`
- Create: `offline-app/index.html`

**Goal:** Sub-project scaffold with no source files yet, ready for `npm install --prefix offline-app`.

### Step 1: Create `offline-app/package.json`

Create `offline-app/package.json`:

```jsonc
{
  "name": "macapp-offline",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@element-plus/icons-vue": "^2.3.1",
    "element-plus": "^2.9.10",
    "pinia": "^3.0.2",
    "vue": "^3.5.13"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "6.0.5",
    "sass": "^1.88.0",
    "typescript": "^5.8.3",
    "vite": "8.0.16",
    "vue-tsc": "^2.2.10"
  }
}
```

### Step 2: Create `offline-app/tsconfig.json`

Create `offline-app/tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "jsx": "preserve",
    "useDefineForClassFields": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "vite.config.ts"]
}
```

### Step 3: Create `offline-app/vite.config.ts`

Create `offline-app/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist-electron/offline-app',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'chrome120',
  },
  server: {
    port: 5175,
    strictPort: true,
  },
});
```

> **关键：`base: './'`** —— 让 `dist-electron/offline-app/index.html` 用相对路径 `./assets/...` 加载子资源，WebContentsView 用 `file://` 协议加载时才能正确解析。

### Step 4: Create `offline-app/index.html`

Create `offline-app/index.html`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'" />
    <title>算粒AI助手</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

### Step 5: Verify scaffold (no install yet)

```bash
cd d:/hudc/git/gitlab/pc/macapp
ls offline-app/
```

Expected:
```
index.html
package.json
tsconfig.json
vite.config.ts
```

### Step 6: Commit

```bash
cd d:/hudc/git/gitlab/pc/macapp
git add offline-app/
git commit -m "【需求/缺陷描述】: 新增 offline-app 子项目脚手架（Vite + Vue 3 + SCSS）
【需求/缺陷单号】: 无
【修改内容】:
- 新增 offline-app/ 子项目（独立 Vite 工程，与 electron/ 平级）
- package.json: vue 3.5 + pinia 3 + element-plus 2.9 + sass 1.88 + vite 8
- vite.config.ts: base: './' 关键配置（file:// 加载子资源）+ outDir: '../dist-electron/offline-app'
- tsconfig.json: paths '@/*' 指向 src/*
- index.html: CSP 收紧到 'self'（与项目内 splash/retry/error 风格一致）"
```

---

## Task 2: 数据层 + Pinia UI store + 全局样式

**Files:**
- Create: `offline-app/src/data/assistantFeatures.ts`
- Create: `offline-app/src/stores/ui.ts`
- Create: `offline-app/src/styles/variables.scss`
- Create: `offline-app/src/styles/global.scss`

**Goal:** All non-component assets ready before components are ported.

### Step 1: Create `offline-app/src/styles/variables.scss`

Create `offline-app/src/styles/variables.scss`:

```scss
// 颜色变量（从 deerflow agent-user 拷，保持视觉一致）
$color-bg-gradient-start: #E8F4FF;
$color-bg-gradient-mid: #F0E8FF;
$color-bg-gradient-end: #FFE8F0;

$color-text-primary: #1a1a1a;
$color-text-secondary: #6b7280;
$color-text-muted: #9ca3af;

$color-card-bg: rgba(255, 255, 255, 0.6);
$color-card-border: rgba(255, 255, 255, 0.8);

$color-accent: #60A5FA;
$color-accent-glow: rgba(96, 165, 250, 0.5);

// 阴影
$shadow-card: 0 4px 20px rgba(0, 0, 0, 0.06);
$shadow-card-hover: 0 8px 30px rgba(0, 0, 0, 0.1);

// 间距（4px 基准）
$spacing-xs: 4px;
$spacing-sm: 8px;
$spacing-md: 12px;
$spacing-lg: 16px;
$spacing-xl: 24px;
```

### Step 2: Create `offline-app/src/styles/global.scss`

Create `offline-app/src/styles/global.scss`:

```scss
@use './variables.scss' as *;

html, body, #app {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
    "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: $color-text-primary;
  user-select: none;
}

::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

* {
  -webkit-app-region: no-drag;
}

// 渐变背景
.app-bg {
  background: linear-gradient(
    160deg,
    $color-bg-gradient-start 0%,
    $color-bg-gradient-mid 45%,
    $color-bg-gradient-end 100%
  );
}

// 玻璃卡片
.glass-card {
  background: $color-card-bg;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid $color-card-border;
  box-shadow: $shadow-card;
}
```

### Step 3: Create `offline-app/src/data/assistantFeatures.ts`

Create `offline-app/src/data/assistantFeatures.ts`:

```ts
// AI 应用切换数据
export interface AIApp {
  id: string;
  name: string;
  icon: string;
  bgColor: string;
}

export const aiApps: AIApp[] = [
  { id: 'qianwen', name: '千问', icon: '通', bgColor: 'bg-blue-500' },
  { id: 'kimi', name: 'Kimi', icon: 'K', bgColor: 'bg-gray-800' },
  { id: 'zhipu', name: '智谱', icon: '智', bgColor: 'bg-blue-600' },
  { id: 'minimax', name: 'MiniMax', icon: 'M', bgColor: 'bg-black' },
  { id: 'keling', name: '可灵', icon: '灵', bgColor: 'bg-purple-500' },
  { id: 'vidu', name: 'Vidu', icon: 'V', bgColor: 'bg-cyan-500' },
];

// 功能卡片数据
export interface FeatureCard {
  title: string;
  desc: string;
  icon: string;
  iconBg: string;
  iconColor: string;
}

export interface FeatureSection {
  id: string;
  title: string;
  subtitle: string;
  headerIcon: string;
  cards: FeatureCard[];
}

export const featureSections: FeatureSection[] = [
  {
    id: 'write',
    title: '算粒写',
    subtitle: 'AI 帮你高效创作',
    headerIcon: '✍️',
    cards: [
      { title: '周报生成', desc: '一键生成工作周报', icon: '📊', iconBg: '#FEF3C7', iconColor: '#D97706' },
      { title: '邮件撰写', desc: '专业得体的邮件', icon: '✉️', iconBg: '#DBEAFE', iconColor: '#2563EB' },
      { title: '文案润色', desc: '让文字更有感染力', icon: '✨', iconBg: '#FCE7F3', iconColor: '#DB2777' },
      { title: '翻译', desc: '多语言精准互译', icon: '🌐', iconBg: '#D1FAE5', iconColor: '#059669' },
    ],
  },
  {
    id: 'listen',
    title: '算粒听',
    subtitle: 'AI 语音交互',
    headerIcon: '🎙️',
    cards: [
      { title: '语音输入', desc: '按住说话，秒变文字', icon: '🎤', iconBg: '#FEE2E2', iconColor: '#DC2626' },
      { title: '会议记录', desc: '自动整理会议要点', icon: '📝', iconBg: '#E0E7FF', iconColor: '#4F46E5' },
      { title: '语音翻译', desc: '说中文，出英文', icon: '🗣️', iconBg: '#FEF3C7', iconColor: '#D97706' },
      { title: '语音克隆', desc: '定制专属 AI 音色', icon: '🎭', iconBg: '#FCE7F3', iconColor: '#DB2777' },
    ],
  },
  {
    id: 'store',
    title: '算粒存',
    subtitle: 'AI 知识管理',
    headerIcon: '📚',
    cards: [
      { title: '笔记摘要', desc: '长文一键提炼要点', icon: '📋', iconBg: '#D1FAE5', iconColor: '#059669' },
      { title: '问答库', desc: '个人专属知识库', icon: '💡', iconBg: '#FEF3C7', iconColor: '#D97706' },
      { title: '文件搜索', desc: '自然语言找文件', icon: '🔍', iconBg: '#DBEAFE', iconColor: '#2563EB' },
      { title: '日程规划', desc: 'AI 帮你安排一天', icon: '📅', iconBg: '#FCE7F3', iconColor: '#DB2777' },
    ],
  },
];

// 底部 Tab 数据
export interface BottomTab {
  id: string;
  name: string;
  icon: string;
}

export const bottomTabs: BottomTab[] = [
  { id: 'home', name: '首页', icon: '🏠' },
  { id: 'discover', name: '发现', icon: '🔍' },
  { id: 'workspace', name: '工作台', icon: '💼' },
  { id: 'me', name: '我的', icon: '👤' },
];

// mock agent 列表（离线场景替代真实 API）
export interface MockAgent {
  name: string;
  icon: string;
  desc: string;
  from: 'public' | 'private';
}

export const mockAgents: { public: MockAgent[]; private: MockAgent[] } = {
  public: [
    { name: '写邮件助手', icon: '✉️', desc: '一键生成专业邮件', from: 'public' },
    { name: '代码评审', icon: '🔍', desc: '智能分析代码质量', from: 'public' },
    { name: '翻译官', icon: '🌐', desc: '多语言互译', from: 'public' },
    { name: '会议纪要', icon: '📝', desc: '自动整理会议要点', from: 'public' },
  ],
  private: [], // 离线模式无登录态，私域为空
};
```

> **注**：`bgColor` 字段（'bg-blue-500' 等）保留为字符串格式——v0.1.0 时是 tailwind 类名。Task 3 的 AppCarousel 组件如果用了这个字段，要么 (a) 替换成 inline style、要么 (b) 在 AppCarousel 里做映射。Task 3 里给出替换指引。

### Step 4: Create `offline-app/src/stores/ui.ts`

Create `offline-app/src/stores/ui.ts`:

```ts
import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 纯 UI 状态 store。
 * 离线模式无登录态、无 API 调用，仅管理 drawer 开关 + 当前激活 tab 等纯前端状态。
 */
export const useUiStore = defineStore('ui', () => {
  const drawerOpen = ref(false);
  const activeTabId = ref('home');
  const activeAppId = ref('qianwen');

  function openDrawer() {
    drawerOpen.value = true;
  }
  function closeDrawer() {
    drawerOpen.value = false;
  }
  function setActiveTab(id: string) {
    activeTabId.value = id;
  }
  function setActiveApp(id: string) {
    activeAppId.value = id;
  }

  return {
    drawerOpen,
    activeTabId,
    activeAppId,
    openDrawer,
    closeDrawer,
    setActiveTab,
    setActiveApp,
  };
});
```

### Step 5: Commit

```bash
cd d:/hudc/git/gitlab/pc/macapp
git add offline-app/src/
git commit -m "【需求/缺陷描述】: 离线页 data + Pinia ui store + 全局样式
【需求/缺陷单号】: 无
【修改内容】:
- data/assistantFeatures.ts: aiApps/featureSections/bottomTabs（从 v0.1.0 + deerflow 拷）+ mockAgents
- stores/ui.ts: Pinia 纯 UI 状态（drawerOpen/activeTabId/activeAppId）
- styles/variables.scss: 颜色/间距/阴影变量
- styles/global.scss: .app-bg 渐变 + .glass-card 玻璃卡片 + 滚动条隐藏"
```

---

## Task 3: 移植 8 个 .vue 组件（从 deerflow agent-user）

**Files:**
- Create: `offline-app/src/components/TopBar.vue`
- Create: `offline-app/src/components/SideDrawer.vue`
- Create: `offline-app/src/components/AppCarousel.vue`
- Create: `offline-app/src/components/FeatureSection.vue`
- Create: `offline-app/src/components/FeatureCard.vue`
- Create: `offline-app/src/components/BottomTabBar.vue`
- Create: `offline-app/src/components/InputBar.vue`

**Goal:** Port all UI components from `D:\hudc\git\gitlab\deerflow\deerflow-frontend\apps\agent-user\src\components\assistant\`. Strip router/stores/axios, replace with local props + ui store.

### Step 1: Copy source components

For each component, copy the source file as starting point:

```bash
SRC="D:/hudc/git/gitlab/deerflow/deerflow-frontend/apps/agent-user/src/components/assistant"
DST="d:/hudc/git/gitlab/pc/macapp/offline-app/src/components"

cp "$SRC/AssistantTopBar.vue"        "$DST/TopBar.vue"
cp "$SRC/AssistantSideDrawer.vue"    "$DST/SideDrawer.vue"
cp "$SRC/AssistantAppCarousel.vue"   "$DST/AppCarousel.vue"
cp "$SRC/AssistantFeatureSection.vue" "$DST/FeatureSection.vue"
cp "$SRC/AssistantFeatureCard.vue"   "$DST/FeatureCard.vue"
cp "$SRC/AssistantBottomTabBar.vue"  "$DST/BottomTabBar.vue"
cp "$SRC/AssistantInputBar.vue"      "$DST/InputBar.vue"
```

### Step 2: Strip router/store imports in each .vue

For each of the 7 copied files, perform these edits:

**TopBar.vue:**
- `<script setup>` 顶部：删除 `import { useRouter } from 'vue-router'` 和 `const router = useRouter()`
- 删除所有 `router.push(...)` / `router.replace(...)` 调用，改为占位 `console.log('topbar action:', label)`
- 保留 `@menu` / `@new-chat` 等 emit

**SideDrawer.vue:**
- 删除所有 `useRouter()` 和 `useUserStore()` import
- 删除路由跳转代码（替换为 `console.log` 占位）
- 登录入口：固定显示「未登录」文案 + 一个 `<el-button>` 按钮，点击仅 `console.log('login clicked (offline)')`

**AppCarousel.vue:**
- 删除 `import { aiApps } from '@/data/features'` — 改为 `defineProps<{ apps: AIApp[] }>()`
- 删除 `useState` —— 改用 `useUiStore().activeAppId` + `setActiveApp()`
- `bgColor` 字段处理：搜索 `'bg-blue-500'` 等字符串字面量，替换为 inline style map：
  ```ts
  const colorMap: Record<string, string> = {
    'bg-blue-500': '#3b82f6',
    'bg-gray-800': '#1f2937',
    'bg-blue-600': '#2563eb',
    'bg-black': '#000000',
    'bg-purple-500': '#a855f7',
    'bg-cyan-500': '#06b6d4',
  };
  ```
  template 中 `:style="{ backgroundColor: colorMap[app.bgColor] ?? '#6b7280' }"`

**FeatureSection.vue / FeatureCard.vue:**
- 删除 `import { featureSections }` —— 改用 `defineProps<{ section: FeatureSection }>()`
- 其它逻辑保持原样（纯展示）

**BottomTabBar.vue:**
- 删除 `import { bottomTabs }` —— 改用 `defineProps<{ tabs: BottomTab[] }>()`
- `activeTabId` 改用 `useUiStore()`

**InputBar.vue:**
- 删除所有 emit 之外的 store / router 调用
- `onSend` / `onVoiceStart` / `onVoiceEnd` 等占位为 `console.log('input action:', type)`

### Step 3: Verify no stray imports

```bash
cd d:/hudc/git/gitlab/pc/macapp/offline-app/src/components
grep -nE "vue-router|@/stores|axios|@agent-infra" *.vue
```

Expected: **no matches**. (If matches appear, strip them per Step 2 instructions.)

### Step 4: Commit

```bash
cd d:/hudc/git/gitlab/pc/macapp
git add offline-app/src/components/
git commit -m "【需求/缺陷描述】: 从 deerflow 移植 7 个 .vue 组件（去掉 router/stores/axios）
【需求/缺陷单号】: 无
【修改内容】:
- 拷贝源：deerflow agent-user/src/components/assistant/{Top,SideDrawer,AppCarousel,Feature*,BottomTabBar,InputBar}
- 删除：所有 vue-router / Pinia stores (userStore/publicStore/privateStore) / axios 引用
- 替换：defineProps 接收父组件传入的 data，状态走 ui store
- AppCarousel: bgColor 字符串映射成 inline style 色值（避开 tailwind 类名）
- 离线场景下所有跳转/操作改为 console.log 占位"
```

---

## Task 4: App.vue + main.ts（入口与布局）

**Files:**
- Create: `offline-app/src/App.vue`
- Create: `offline-app/src/main.ts`

**Goal:** Mount point + layout shell, ready for `npm run dev` to start dev server.

### Step 1: Create `offline-app/src/main.ts`

Create `offline-app/src/main.ts`:

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

### Step 2: Create `offline-app/src/App.vue`

Create `offline-app/src/App.vue`:

```vue
<script setup lang="ts">
import TopBar from '@/components/TopBar.vue';
import SideDrawer from '@/components/SideDrawer.vue';
import AppCarousel from '@/components/AppCarousel.vue';
import FeatureSection from '@/components/FeatureSection.vue';
import BottomTabBar from '@/components/BottomTabBar.vue';
import InputBar from '@/components/InputBar.vue';
import { aiApps, featureSections, bottomTabs } from '@/data/assistantFeatures';
import { useUiStore } from '@/stores/ui';

const ui = useUiStore();

// 离线场景：所有用户操作均占位
function onMenu() { ui.openDrawer(); }
function onNewChat() { console.log('new chat (offline)'); }
function onAppSelect(id: string) { ui.setActiveApp(id); }
function onTabSelect(id: string) { ui.setActiveTab(id); }
function onSend(_text: string) { console.log('send (offline)'); }
function onVoiceStart() { console.log('voice start (offline)'); }
function onVoiceEnd() { console.log('voice end (offline)'); }
function onCamera() { console.log('camera (offline)'); }
function onMore() { console.log('more (offline)'); }
</script>

<template>
  <div class="app-bg desktop-shell">
    <!-- 顶部导航 -->
    <TopBar @menu="onMenu" @new-chat="onNewChat" />

    <!-- 侧边抽屉 -->
    <SideDrawer v-model="ui.drawerOpen" />

    <!-- 主滚动区 -->
    <main class="main">
      <!-- AI 应用切换 -->
      <AppCarousel :apps="aiApps" @select="onAppSelect" />

      <!-- 三大功能区块 -->
      <div class="sections">
        <FeatureSection
          v-for="section in featureSections"
          :key="section.id"
          :section="section"
        />
      </div>
    </main>

    <!-- 底部 Tab 栏 -->
    <BottomTabBar :tabs="bottomTabs" @select="onTabSelect" />

    <!-- 底部输入栏 -->
    <InputBar
      @send="onSend"
      @voice-start="onVoiceStart"
      @voice-end="onVoiceEnd"
      @camera="onCamera"
      @more="onMore"
    />
  </div>
</template>

<style lang="scss" scoped>
.desktop-shell {
  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main {
  flex: 1;
  overflow-y: auto;
}

.sections {
  padding: 8px 0;
}
</style>
```

### Step 3: Install offline-app dependencies

```bash
cd d:/hudc/git/gitlab/pc/macapp
npm --prefix offline-app install --no-audit --no-fund
```

Expected: `node_modules/` appears in `offline-app/`. No errors.

### Step 4: Type check (sanity)

```bash
cd d:/hudc/git/gitlab/pc/macapp/offline-app
npx vue-tsc --noEmit
```

Expected: **no output, exit code 0**. If errors appear, fix missing imports / type definitions.

### Step 5: Commit

```bash
cd d:/hudc/git/gitlab/pc/macapp
git add offline-app/src/App.vue offline-app/src/main.ts offline-app/package-lock.json
git commit -m "【需求/缺陷描述】: 离线页 App.vue + main.ts 入口
【需求/缺陷单号】: 无
【修改内容】:
- main.ts: createApp + Pinia + Element Plus + global.scss
- App.vue: TopBar + SideDrawer + AppCarousel + 3 个 FeatureSection + BottomTabBar + InputBar 布局
- 所有用户交互 console.log 占位（离线场景无业务逻辑）
- install offline-app 依赖（生成 package-lock.json）"
```

---

## Task 5: Dev 调试 + 视觉对比

**Files:** (no file changes — verification task)

**Goal:** Confirm dev server runs cleanly and UI matches the deerflow reference at `http://localhost:5195/agent-user/assistant`.

### Step 1: Start dev server in background

```bash
cd d:/hudc/git/gitlab/pc/macapp
npm run dev:offline &
```

Expected: Vite reports `Local: http://localhost:5175/`.

### Step 2: Open browser and inspect

Open `http://localhost:5175/` in browser. Verify:

- [ ] 顶部 TopBar 显示「算粒AI助手」标题 + hamburger + 「+」按钮
- [ ] AI 应用切换条水平滚动可见 6 个 app（千问/Kimi/智谱/MiniMax/可灵/Vidu）
- [ ] 三大功能区块（算粒写/算粒听/算粒存）每个区块显示 4 个 2x2 卡片
- [ ] 底部 Tab 栏 4 个 tab（首页/发现/工作台/我的）
- [ ] 底部输入栏（语音按钮 + 输入框 + 拍照/更多按钮）
- [ ] 背景渐变（左上蓝 → 中间紫 → 右下粉）
- [ ] 玻璃卡片半透明效果

### Step 3: Compare with reference

Open deerflow dev server in another browser tab (`http://localhost:5195/agent-user/assistant`). Side-by-side compare:

- [ ] 整体布局尺寸一致（h-screen + flex-col + 顶部/底部固定）
- [ ] 颜色方案一致（渐变背景色 + 卡片配色）
- [ ] 卡片网格 2x2 排列 + 圆角
- [ ] 输入栏布局（语音 / 输入框 / 拍照 / 更多）

> **不要求 100% 像素一致**——deerflow 的 Assistant 页有「我的智能体」section，离线页故意不挂载（无登录态）。其余区块视觉一致即视为通过。

### Step 4: Check console for errors

In the browser DevTools Console (F12), verify:

- **No errors** (warnings about missing components or imports are OK to investigate)
- No 404s in Network tab

### Step 5: Stop dev server

```bash
# Ctrl+C in the terminal where dev:offline is running
```

---

## Task 6: vite build 验证产物结构

**Files:** (no file changes — verification task)

**Goal:** Confirm `vite build` writes to `dist-electron/offline-app/` with the expected file layout.

### Step 1: Ensure dist-electron/ exists

```bash
cd d:/hudc/git/gitlab/pc/macapp
ls dist-electron/ 2>/dev/null || npm run build:electron
```

If `dist-electron/` doesn't exist, run `build:electron` to create it (vite's `emptyOutDir: true` requires the parent directory to exist).

### Step 2: Run vite build

```bash
cd d:/hudc/git/gitlab/pc/macapp
npm run build:offline
```

Expected: Vite reports `✓ built in XXXms` and `../dist-electron/offline-app/` is the output directory.

### Step 3: Verify output layout

```bash
ls -la dist-electron/offline-app/
ls -la dist-electron/offline-app/assets/
```

Expected:
```
dist-electron/offline-app/
├── index.html
└── assets/
    ├── index-xxxxxx.js
    └── index-xxxxxx.css
```

### Step 4: Verify index.html uses relative paths

```bash
cd d:/hudc/git/gitlab/pc/macapp
cat dist-electron/offline-app/index.html
```

Expected: `<script>` and `<link>` tags use `./assets/...` (relative paths), **not** `/assets/...` (absolute paths). This is critical for file:// loading.

If absolute paths appear, check `vite.config.ts` has `base: './'`.

### Step 5: Commit (no source changes; build artifacts are gitignored)

Confirm `dist-electron/` is in `.gitignore`:

```bash
cat .gitignore | grep dist-electron
```

Expected: `dist-electron/` line present. (If absent, add it.)

### Step 6: Clean build artifacts (optional)

```bash
rm -rf dist-electron/offline-app
```

(Keeps repo clean for the next build. The CI build will regenerate.)

---

## Task 7: 根 package.json scripts 调整

**Files:**
- Modify: `package.json` (root)

**Goal:** Add `dev:offline` + `build:offline`; reorder `build` to put `build:electron` first.

### Step 1: Inspect current scripts

```bash
cd d:/hudc/git/gitlab/pc/macapp
cat package.json | grep -A 20 '"scripts"'
```

### Step 2: Add new scripts and reorder build

In `package.json` `scripts` section, **add** the two new scripts and **replace** the existing `build` script:

```jsonc
{
  // ... existing scripts ...
  "dev:offline": "npm --prefix offline-app run dev",
  "build:offline": "npm --prefix offline-app install --no-audit --no-fund && npm --prefix offline-app run build",
  // ...
  "build": "npm run build:electron && npm run build:offline"
}
```

The exact insertion point depends on existing script ordering — place `dev:offline` next to other dev scripts, and `build:offline` next to `build:electron`. Keep `build` as the last entry in `scripts`.

### Step 3: Verify

```bash
cd d:/hudc/git/gitlab/pc/macapp
npm run | grep -E "offline|build"
```

Expected output (abridged):
```
  dev:offline
  build:electron
  build:offline
  build
```

### Step 4: Smoke test `build:offline` from root

```bash
cd d:/hudc/git/gitlab/pc/macapp
ls dist-electron/ 2>/dev/null || npm run build:electron
npm run build:offline
ls dist-electron/offline-app/index.html
```

Expected: `dist-electron/offline-app/index.html` exists.

### Step 5: Commit

```bash
cd d:/hudc/git/gitlab/pc/macapp
git add package.json
git commit -m "【需求/缺陷描述】: 根 package.json scripts 增加 dev:offline / build:offline
【需求/缺陷单号】: 无
【修改内容】:
- 新增 dev:offline: npm --prefix offline-app run dev（独立调试离线页）
- 新增 build:offline: install + vite build（产物到 dist-electron/offline-app/）
- 调整 build 顺序：先 build:electron 创建 dist-electron/，再 build:offline 写入子目录"
```

---

## Task 8: config.ts + config.jsonc 加 useOfflineFallback 字段

**Files:**
- Modify: `electron/config.ts`
- Modify: `config.jsonc`

**Goal:** Add `useOfflineFallback: boolean` (default `true`) to config schema, with full validation.

### Step 1: Add field to `AppConfig` interface

In `electron/config.ts`, add a new field after line 35 (`dismissCooldownHours`):

```ts
  /** 是否使用离线兜底页面替代 retry/error 视图（默认 true） */
  useOfflineFallback: boolean;
```

### Step 2: Add validation in `validateConfig`

In `electron/config.ts`, add the validation block after the `dismissCooldownHours` validation (after line 249):

```ts
  // useOfflineFallback
  if (!('useOfflineFallback' in o)) {
    errors.push('字段 useOfflineFallback 缺失');
  } else if (typeof o.useOfflineFallback !== 'boolean') {
    errors.push(`useOfflineFallback 必须是 boolean (实际: ${JSON.stringify(o.useOfflineFallback)})`);
  }
```

### Step 3: Add to return value

In `electron/config.ts`, inside the `validateConfig` return (around line 264), add:

```ts
    useOfflineFallback: o.useOfflineFallback as boolean,
```

### Step 4: Add log line

In `electron/config.ts`, inside `loadConfig` after the existing `log.info(...)` calls (around line 332), add:

```ts
  log.info(`离线兜底: ${validated.useOfflineFallback ? '启用' : '禁用（使用 retry/error 模式）'}`);
```

### Step 5: Add to `config.jsonc`

Append to `config.jsonc` after the last field:

```jsonc
  ,
  // 是否使用离线兜底页面作为 contentView 加载失败的回退视图。
  // true（默认）：失败直接切到离线页（v0.1.0 风格 UI），不重试
  // false：使用原有 retry → error 流程（重试 N 次后显示错误页）
  "useOfflineFallback": true
```

### Step 6: Verify validation

Start the app with a missing field:

```bash
cd d:/hudc/git/gitlab/pc/macapp
# Temporarily comment out the new field in config.jsonc
npm start
```

Expected: app exits with `[config] ✗ 字段校验失败: config.jsonc - 字段 useOfflineFallback 缺失`.

Restore the field.

### Step 7: Verify wrong type

```bash
# Temporarily change to a number
# "useOfflineFallback": 123
npm start
```

Expected: `useOfflineFallback 必须是 boolean (实际: 123)`. Restore.

### Step 8: Verify correct value

```bash
# Restore to true
npm start
```

Expected: log line `离线兜底: 启用`. (Note: app will still try to load contentView normally — main.ts integration is Task 9.)

### Step 9: Commit

```bash
cd d:/hudc/git/gitlab/pc/macapp
git add electron/config.ts config.jsonc
git commit -m "【需求/缺陷描述】: config 增加 useOfflineFallback 字段（默认 true）
【需求/缺陷单号】: 无
【修改内容】:
- AppConfig: 新增 useOfflineFallback: boolean（默认 true）
- validateConfig: 必填校验 + 类型校验
- loadConfig: 日志输出\"离线兜底: 启用/禁用\"
- config.jsonc: 新字段示例值 true，附中文注释说明"
```

---

## Task 9: main.ts 集成 offlineView + 分支逻辑

**Files:**
- Modify: `electron/main.ts`

**Goal:** Add `offlineView`, conditionally create retry/error views, branch `did-fail-load` and `render-process-gone` on `useOfflineFallback`, make `showOnly` null-safe.

### Step 1: Update module-level view declarations

In `electron/main.ts`, modify lines 14-19 to add `offlineView`:

```ts
let mainWindow: BrowserWindow | null = null;
let loadingView: WebContentsView | null = null;
let retryView: WebContentsView | null = null;
let errorView: WebContentsView | null = null;
let offlineView: WebContentsView | null = null; // 新增：离线兜底页面（useOfflineFallback=true 时使用）
let contentView: WebContentsView | null = null;
let retryCount = 0;
let loadFailed = false;
```

### Step 2: Make `showOnly` null-safe

Replace the `showOnly` function (lines 24-29) with:

```ts
function showOnly(view: WebContentsView | null) {
  loadingView?.setVisible(view === loadingView);
  retryView?.setVisible(view === retryView);
  errorView?.setVisible(view === errorView);
  offlineView?.setVisible(view === offlineView);
  contentView?.setVisible(view === contentView);
}
```

The `?.` operator handles the case where retry/error/offline view is `null` in some configurations.

### Step 3: Conditional view creation in `createMainWindow`

In `createMainWindow`, after the mainWindow creation (around line 117), replace the unconditional creation of retry/error views with conditional logic:

```ts
  const OFFLINE_PAGE = 'offline-app/index.html';
  const useOffline = config.useOfflineFallback;
  log.info(`view strategy: ${useOffline ? 'offline-fallback' : 'retry-then-error'}`);

  // 创建四个 View：loading / retry / error / content(URL)
  loadingView = createView('splash.html');
  if (useOffline) {
    // 离线模式：只创建 loadingView + offlineView + contentView（retry/error 不创建）
    offlineView = createView(OFFLINE_PAGE);
    log.info('offlineView created (offline fallback mode)');
  } else {
    // 原 retry/error 模式
    retryView = createView('retry.html');
    errorView = createView('error.html', { targetUrl: TARGET_URL });
    log.info('retryView + errorView created (legacy mode)');
  }
  contentView = createUrlView(TARGET_URL);
```

### Step 4: Branch `did-fail-load`

Replace the `did-fail-load` handler (lines 142-163) with:

```ts
  contentView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    loadFailed = true;
    log.error(`content view did-fail-load: ${errorCode} ${errorDescription} url=${validatedURL}`);

    if (useOffline && offlineView) {
      // 离线模式：直接切到 offlineView，不重试
      log.warn('falling back to offline page (no retry)');
      showOnly(offlineView);
      return;
    }

    // 原 retry/error 流程（useOfflineFallback=false）
    if (retryCount < MAX_RETRIES) {
      retryCount += 1;
      log.warn(`retry ${retryCount}/${MAX_RETRIES}`);
      retryView?.webContents.executeJavaScript(
        `document.querySelector('.label').textContent = '正在重试 ${retryCount}/${MAX_RETRIES}…';`
      );
      showOnly(retryView);
      setTimeout(() => {
        loadFailed = false;
        if (contentView && !contentView.webContents.isDestroyed()) {
          contentView.webContents.reload();
        }
      }, RETRY_DELAY_MS);
    } else {
      log.error(`gave up after ${MAX_RETRIES} retries, switching to error view`);
      showOnly(errorView);
    }
  });
```

### Step 5: Branch `render-process-gone`

Replace the `render-process-gone` handler (lines 165-188) with:

```ts
  contentView.webContents.on('render-process-gone', (_event, details) => {
    log.error(`render-process-gone: ${JSON.stringify(details)}`);
    if (!contentView || contentView.webContents.isDestroyed()) return;

    if (retryCount < MAX_RETRIES) {
      retryCount += 1;
      log.warn(`retry ${retryCount}/${MAX_RETRIES} (after render-process-gone)`);
      retryView?.webContents.executeJavaScript(
        `document.querySelector('.label').textContent = '正在重试 ${retryCount}/${MAX_RETRIES}…';`
      );
      showOnly(retryView);
      setTimeout(() => {
        loadFailed = false;
        if (contentView && !contentView.webContents.isDestroyed()) {
          contentView.webContents.reload();
        }
      }, RETRY_DELAY_MS);
    } else {
      if (useOffline && offlineView) {
        log.warn('render-process-gone retry exhausted, falling back to offline page');
        showOnly(offlineView);
      } else {
        log.error(`gave up after ${MAX_RETRIES} retries (after render-process-gone), switching to error view`);
        showOnly(errorView);
      }
    }
  });
```

### Step 6: Update `closed` handler

In the `mainWindow.on('closed')` handler (lines 225-231), add `offlineView = null`:

```ts
  mainWindow.on('closed', () => {
    mainWindow = null;
    loadingView = null;
    retryView = null;
    errorView = null;
    offlineView = null;
    contentView = null;
  });
```

### Step 7: Verify TypeScript compiles

```bash
cd d:/hudc/git/gitlab/pc/macapp
npm run build:electron
```

Expected: `✅ Electron 编译完成` and `dist-electron/main.js` regenerated.

If TypeScript errors appear, fix them per error messages.

### Step 8: Commit

```bash
cd d:/hudc/git/gitlab/pc/macapp
git add electron/main.ts
git commit -m "【需求/缺陷描述】: 主进程集成 offlineView（useOfflineFallback 分支）
【需求/缺陷单号】: 无
【修改内容】:
- module-level: 新增 offlineView 声明
- showOnly: 全部用 ?.setVisible() 兼容 null（offline 模式下 retry/error 不创建）
- createMainWindow: 根据 config.useOfflineFallback 条件创建 retry/error 或 offline
- did-fail-load: offline 模式直接 showOnly(offlineView) 后 return；非 offline 走原 retry/error
- render-process-gone: 重试用尽后分支（offline 模式切 offlineView，原模式切 errorView）
- closed handler: offlineView = null
- 不动 IPC / will-navigate / setWindowOpenHandler / resize"
```

---

## Task 10: 集成验证（5 场景）

**Files:** (no file changes — verification task)

**Goal:** Verify all 5 scenarios from spec § 8.

### Step 1: Build everything

```bash
cd d:/hudc/git/gitlab/pc/macapp
npm run build
```

Expected: Both `dist-electron/main.js` and `dist-electron/offline-app/index.html` exist. No errors.

### Step 2: Scenario A — 离线页独立调试

```bash
cd d:/hudc/git/gitlab/pc/macapp
npm run dev:offline &
# Browser opens http://localhost:5175/
```

Verify (Task 5 checklist):
- [ ] UI 与 reference 一致（背景渐变 + 三大功能区块 + 底部 Tab + 输入栏）
- [ ] 无 console error

Kill dev server (Ctrl+C).

### Step 3: Scenario B — 主流程正常加载（useOfflineFallback=true，targetUrl 正常）

```bash
cd d:/hudc/git/gitlab/pc/macapp
# Use the real targetUrl from config.jsonc
npm start
```

Expected:
- [ ] loadingView 显示 1~2s
- [ ] contentView 加载成功，正常显示线上 URL
- [ ] 日志：`view strategy: offline-fallback` + `content view did-finish-load, switching to contentView`

### Step 4: Scenario C — 离线降级（useOfflineFallback=true，targetUrl 不可达）

```bash
# Edit config.jsonc targetUrl to http://localhost:9999/ (unreachable port)
npm run build:offline && npm start
```

Expected:
- [ ] loadingView 显示 → 短暂过渡
- [ ] contentView 加载失败 → **直接**切到 offlineView（不重试）
- [ ] 日志：`falling back to offline page (no retry)`
- [ ] 离线页 UI 正常展示（Vite 编译产物加载成功）

Restore `targetUrl` to the original value.

### Step 5: Scenario D — retry/error 模式保留（useOfflineFallback=false）

```bash
# Edit config.jsonc: useOfflineFallback=false
# Edit config.jsonc targetUrl to http://localhost:9999/
npm start
```

Expected:
- [ ] retryView 显示 `正在重试 1/3…` → `2/3` → `3/3`（每 5s 一次）
- [ ] 重试 3 次后切到 errorView
- [ ] 日志：`view strategy: retry-then-error` + 3 次 retry 日志 + `gave up after 3 retries`

Restore `useOfflineFallback=true` and `targetUrl`.

### Step 6: Scenario E — 回归验证（useOfflineFallback=false，targetUrl 正常）

```bash
# Keep useOfflineFallback=false, restore targetUrl
npm start
```

Expected:
- [ ] 行为与 v0.5.6 **完全一致**（contentView 加载成功，正常显示线上 URL；不创建 offlineView；retry/error view 存在但不显示）

After verification, restore `useOfflineFallback=true` (default).

### Step 7: Commit (if any tweaks were needed)

If you made any config tweaks during verification, commit them:

```bash
cd d:/hudc/git/gitlab/pc/macapp
git status
# If only config.jsonc changed (shouldn't — it's runtime config), verify it's not in git:
git check-ignore config.jsonc && echo "config.jsonc is gitignored, no commit needed"
```

(`config.jsonc` is typically gitignored; changes don't get committed.)

---

## Task 11: README 文档

**Files:**
- Modify: `README.md`

**Goal:** Document the new offline fallback mode in user-facing docs.

### Step 1: Locate insertion point

```bash
cd d:/hudc/git/gitlab/pc/macapp
grep -n "📋 日志文件\|🐛 常见问题\|🔄 在线更新" README.md
```

Insert the new section between the most recently-added section and the next.

### Step 2: Add section

Insert the following section in `README.md`:

```markdown
## 🛡️ 离线兜底页面

当 `targetUrl`（线上 URL）加载失败时，应用会显示一个本地静态页面作为兜底，**不再进行重试**。兜底页面 UI 与 `http://localhost:5195/agent-user/assistant` 一致，提供熟悉的导航 + 功能介绍 + 输入栏体验。

### 配置

`config.jsonc`：

```jsonc
{
  "useOfflineFallback": true,  // 默认 true；设为 false 回到 v0.5.6 的 retry → error 流程
  // ...
}
```

### 行为对照

| 场景 | `useOfflineFallback: true`（默认） | `useOfflineFallback: false` |
|------|-----------------------------------|----------------------------|
| 加载成功 | contentView 显示线上 URL | 同左 |
| 加载失败 | **直接**切到离线兜底页（不重试） | retryView 重试 N 次 → errorView |
| render-process-gone | 重试 N 次 → 离线兜底页 | 重试 N 次 → errorView |

### 独立调试

```bash
npm run dev:offline
# 浏览器打开 http://localhost:5195/
```

仅启动 Vite dev server，不依赖 Electron 主进程，方便 UI 调试与样式调整。
```

### Step 3: Commit

```bash
cd d:/hudc/git/gitlab/pc/macapp
git add README.md
git commit -m "【需求/缺陷描述】: README 增加「🛡️ 离线兜底页面」章节
【需求/缺陷单号】: 无
【修改内容】:
- 新章节：背景说明（兜底页与线上 URL 切换逻辑）
- 配置示例：useOfflineFallback 默认 true，附 false 行为说明
- 行为对照表：两种模式的失败处理路径
- 独立调试入口：npm run dev:offline 介绍"
```

---

## Self-Review

**1. Spec coverage:**

| Spec Section | Covered by |
|---|---|
| § 1.1 文件清单 | Tasks 1-9, 11 |
| § 1.2 依赖图 | Tasks 1, 3, 4, 7, 9 |
| § 1.3 状态机 | Task 9 (offline 分支) + Task 10 (回归测试) |
| § 2.1 package.json | Task 1 |
| § 2.2 vite.config.ts | Task 1 |
| § 2.3 入口与全局挂载 | Task 4 |
| § 2.4 离线简化策略 | Task 2 (mockAgents) + Task 3 (strip stores/router) |
| § 3.1 根 scripts 调整 | Task 7 |
| § 3.2 scripts/build-electron.js 不需改 | Implicit (no changes needed) |
| § 4.1 config.ts 字段 | Task 8 |
| § 4.2 main.ts 改动 | Task 9 |
| § 5 config.jsonc | Task 8 |
| § 6 关键决策 | Implicit (architectural choices reflected in plan structure) |
| § 7 未来工作 | Out of scope (explicitly not done) |
| § 8 验证 | Task 10 |

**2. Placeholder scan:** No TBD / TODO / "implement later" patterns. All code is complete.

**3. Type consistency:**
- `useOfflineFallback` used identically in: config.ts (interface + validation + return), main.ts (config.useOfflineFallback + useOffline local alias), config.jsonc
- `offlineView` declared at module level (Task 9 Step 1), assigned in createMainWindow (Task 9 Step 3), reset in closed handler (Task 9 Step 6), used in showOnly (Task 9 Step 2) and did-fail-load (Task 9 Step 4) and render-process-gone (Task 9 Step 5)
- `useUiStore` exported in Task 2 Step 4, imported in App.vue (Task 4) and SideDrawer/AppCarousel (Task 3)
- `assistantFeatures` exports match what App.vue imports (Task 2 → Task 4)

No issues found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-22-offline-fallback-page.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
