# opencode 按需静默安装 + macapp 启动自启 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macapp 启动时若 opencode 可用自动后台 spawn `opencode web`；用户首次点"写代码" tab 时若未装则静默 `npm i -g opencode-ai`，装完自动切到内嵌 opencode web 的编码页。

**Architecture:** 新增 `electron/codingAgent.ts` 单例模块（detect / install / spawn / health / lifecycle），主进程启动期 `setImmediate(tryAutostart)` + before-quit 回收；新增 `window.electronAPI.coding.*` IPC 命名空间；offline-app 加 `coding-toast.ts` + ui store 订阅 coding:status，FeatureCard「写代码」和 BottomTabBar「code」tab 共用入口 `onCodeClick()` 调 `coding.open()`；view 切换完全在主进程（`showOnly` 是主进程函数），前端只听 status 做 toast/视觉态。

**Tech Stack:** Electron 43 (main process, IPC, WebContentsView, child_process spawn / spawnSync, net), Vue 3 + Pinia (offline-app), Element Plus (ElMessage / ElNotification), jsonc-parser (config 迁移，沿用现有), electron-logger (沿用现有 `electron/logger.ts`).

**Spec:** [docs/superpowers/specs/2026-09-08-opencode-on-demand-install-and-autostart-design.md](../../specs/2026-09-08-opencode-on-demand-install-and-autostart-design.md)

**Important notes:**
- 仓库无测试 runner（package.json 仅构建工具）。本计划所有 `.test.ts` 文件**只写不跑**——作为行为文档，待后续引入 vitest 时一并接入（spec §7.6 YAGNI 决定）。
- 每步验证走「运行 `npm run dev`（含 Vite + Electron）+ 手动操作」而非单元测试。
- 不改安装器（.dmg / NSIS / .pkg 都不动）。opencode 通过 npm 全局装在用户 PATH。

---

## File Structure

### 新增文件

| 文件 | 职责 |
|---|---|
| `electron/codingAgent.ts` | 单例模块：detect / detectNode / pickPort / install / spawn / healthCheck / 状态机 / emit / handleOpen / handleRetry / tryAutostart / shutdown |
| `electron/codingAgent.test.ts` | 行为文档（不跑，未来 vitest 接入）：覆盖 detect / pickPort / install 命令构造 / 状态机转换 |
| `offline-app/src/types/coding.ts` | renderer 侧 CodingStatus 类型副本（main/renderer 独立 tsconfig，无共享类型目录） |
| `offline-app/src/coding-toast.ts` | Element Plus 封装：codingToast(status) + notifyNoNode(message) |

### 修改文件

| 文件 | 改动 |
|---|---|
| `electron/config.ts` | `AppConfig` 加 `codingAgent` 嵌套对象；`validateConfig` 新增校验；迁移逻辑无需改（沿用「缺字段从 bundled 补齐」） |
| `electron/main.ts` | `app.whenReady().then` 加 `setImmediate(tryAutostart)`；`before-quit` 加 `codingAgent.shutdown()`；`registerIpcHandlers(mode)` 末尾追加 `coding:*` 一组 |
| `electron/preload.ts` | `window.electronAPI` 加 `coding: { open / close / retry / onStatus }` |
| `config.jsonc` | 加 `codingAgent` 默认值块 |
| `offline-app/src/stores/ui.ts` | 加 `codingStatus` + `isInCodingView` ref；订阅 `onStatus`；HMR 清理沿用现有模式 |
| `offline-app/src/data/assistantFeatures.ts` | 「写代码」卡片加 `action: 'coding'` 字段 |
| `offline-app/src/App.vue` | 加 `onCodeClick()` 处理函数；`FeatureSection` 卡片 click 判断 action；`BottomTabBar` 的 `code` tab 走 `onCodeClick` |
| `offline-app/src/main.ts` | 无改动（types 已在 store 引入） |

### 不改的文件

- `offline-app/src/components/TopBar.vue` / `SideDrawer.vue` / `BottomTabBar.vue` / `FeatureSection.vue` / `FeatureCard.vue` / `AppCarousel.vue` —— 编码 tab 复用现有 console.log 占位（由 App.vue 改成 `onCodeClick` 统一接管）
- `offline-app/src/components/InputBar.vue` —— 不相关
- `electron/updater.ts` / `electron/logger.ts` —— 沿用现有

---

## Task 1: CodingStatus 类型（main 侧）

**Files:**
- Create: `electron/codingAgent.ts`（先只放类型，不写实现）

### Steps

- [ ] **Step 1: 创建 electron/codingAgent.ts，导出类型**

```ts
// electron/codingAgent.ts
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { logger } from './logger';

const log = logger.child('coding');

/**
 * codingAgent 的对外状态。
 *
 * 状态机：
 *   unavailable ─► spawning ─► ready ─► exited
 *        │           │           │
 *        │           │           └─► spawning (retry)
 *        │           └─► timeout / spawn-failed
 *        └─► installing ─► spawning ─► ready
 *                    │
 *                    └─► install-failed / no-node
 *
 * 由 main process 持有单一 source of truth，通过 `coding:status` IPC 推给 renderer。
 */
export type CodingStatus =
  | { state: 'unavailable' }
  | { state: 'spawning' }
  | { state: 'ready'; url: string }
  | { state: 'installing' }
  | { state: 'exited'; code: number; signal?: string }
  | { state: 'spawn-failed'; message: string }
  | { state: 'timeout' };

/** open() / retry() 的返回类型 */
export type CodingOpenResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'no-node' | 'install-failed' | 'still-missing' | 'spawn-failed' | 'timeout'; message: string };

/** config.jsonc.codingAgent 字段（运行时使用） */
export interface CodingAgentConfig {
  enable: boolean;
  binPath: string;
  installSource: string;
  port: number;
  defaultDir: string;
  autostart: boolean;
}
```

- [ ] **Step 2: 在 main.ts 顶部加 import 占位（暂不调用）**

打开 [electron/main.ts:8-10](electron/main.ts#L8-L10)，确认 `logger` 已经 import，`codingAgent` 模块暂时无需在 main.ts 引用（Task 10 才接入）。

- [ ] **Step 3: Commit**

```bash
git add electron/codingAgent.ts
git commit -m "feat(coding): add CodingStatus / CodingOpenResult / CodingAgentConfig types

占位类型文件，Task 3 起逐步加实现。"
```

按项目 commit 格式：
```
【需求/缺陷描述】: codingAgent 模块占位类型（CodingStatus / CodingOpenResult / CodingAgentConfig）
【需求/缺陷单号】: 无
【修改内容】:
- 新增 electron/codingAgent.ts，仅导出类型，无实现
- 状态机文档：unavailable → spawning → ready → exited；installing 分支
- 后续 Task 3 起逐步加 detect / install / spawn / healthCheck / handleOpen / tryAutostart / shutdown
```

---

## Task 2: CodingStatus 类型（renderer 侧副本）

**Files:**
- Create: `offline-app/src/types/coding.ts`

### Steps

- [ ] **Step 1: 创建 renderer 侧类型副本**

```ts
// offline-app/src/types/coding.ts
/**
 * CodingStatus — renderer 侧副本。
 *
 * main/renderer 独立 tsconfig，没有共享类型目录；这里手动同步 electron/codingAgent.ts 的 CodingStatus。
 * 两边类型必须保持一致；后续如有共享需求再抽公共类型。
 */
export type CodingStatus =
  | { state: 'unavailable' }
  | { state: 'spawning' }
  | { state: 'ready'; url: string }
  | { state: 'installing' }
  | { state: 'exited'; code: number; signal?: string }
  | { state: 'spawn-failed'; message: string }
  | { state: 'timeout' };
```

- [ ] **Step 2: 确认 vite 编译通过**

Run: `npm run build:offline`
Expected: 编译成功，无 TS 错误。

- [ ] **Step 3: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: renderer 侧 CodingStatus 类型副本
【需求/缺陷单号】: 无
【修改内容】:
- 新增 offline-app/src/types/coding.ts
- 副本自 electron/codingAgent.ts CodingStatus（无共享类型目录前的临时方案）
```

---

## Task 3: config.ts 加 codingAgent 字段 + 校验

**Files:**
- Modify: `electron/config.ts:19-46`（AppConfig 接口）
- Modify: `electron/config.ts:157-271`（validateConfig 函数）
- Modify: `electron/config.ts:411-416`（日志新增一行）

### Steps

- [ ] **Step 1: 在 AppConfig 接口加 codingAgent**

打开 [electron/config.ts](electron/config.ts)，定位 `AppConfig` 接口（§3.1 行 19-46）。在 `useOfflineFallback` 字段后追加：

```ts
  /**
   * opencode AI 编程助手集成（v1.1 起）。
   * 字段缺失时由 bundled default 补齐（沿用现有迁移机制）。
   */
  codingAgent: {
    /** 总开关；false 时编码 tab 隐藏，codingAgent 不初始化 */
    enable: boolean;
    /** 自定义 opencode 可执行路径；空 = which/where 探测 */
    binPath: string;
    /** 自定义安装源（v1.1 预留不解析） */
    installSource: string;
    /** opencode web 监听端口；占用时自动探测 port+1 ~ port+4 */
    port: number;
    /** opencode web 启动 cwd；空 = 平台默认（macOS: ~/Documents, Win: ~） */
    defaultDir: string;
    /** macapp 启动时若 opencode 可用，自动后台 spawn opencode web */
    autostart: boolean;
  };
```

- [ ] **Step 2: 在 validateConfig 加 codingAgent 校验**

定位 `validateConfig` 函数（[electron/config.ts:157-271](electron/config.ts#L157-L271)）。在 `useOfflineFallback` 校验块后追加：

```ts
  // codingAgent
  if (!('codingAgent' in o)) {
    errors.push('字段 codingAgent 缺失');
  } else {
    const ca = o.codingAgent as Record<string, unknown>;
    if (typeof ca !== 'object' || ca === null || Array.isArray(ca)) {
      errors.push('codingAgent 必须是对象');
    } else {
      const caErrors: string[] = [];
      if (typeof ca.enable !== 'boolean') caErrors.push(`enable 必须是 boolean (实际: ${JSON.stringify(ca.enable)})`);
      if (typeof ca.binPath !== 'string') caErrors.push(`binPath 必须是 string (实际: ${JSON.stringify(ca.binPath)})`);
      if (typeof ca.installSource !== 'string') caErrors.push(`installSource 必须是 string (实际: ${JSON.stringify(ca.installSource)})`);
      if (!Number.isInteger(ca.port) || (ca.port as number) < 1 || (ca.port as number) > 65535) {
        caErrors.push(`port 必须是 1-65535 整数 (实际: ${JSON.stringify(ca.port)})`);
      }
      if (typeof ca.defaultDir !== 'string') caErrors.push(`defaultDir 必须是 string (实际: ${JSON.stringify(ca.defaultDir)})`);
      if (typeof ca.autostart !== 'boolean') caErrors.push(`autostart 必须是 boolean (实际: ${JSON.stringify(ca.autostart)})`);
      if (caErrors.length > 0) {
        errors.push(`codingAgent 字段错误:\n  - ${caErrors.join('\n  - ')}`);
      }
    }
  }
```

- [ ] **Step 3: validateConfig 末尾构造返回值时同步返回 codingAgent**

定位 `validateConfig` 返回前（[electron/config.ts:258-270](electron/config.ts#L258-L270)），把 `useOfflineFallback: o.useOfflineFallback as boolean,` 后面追加：

```ts
    codingAgent: (() => {
      const ca = o.codingAgent as Record<string, unknown>;
      return {
        enable: ca.enable as boolean,
        binPath: ca.binPath as string,
        installSource: ca.installSource as string,
        port: ca.port as number,
        defaultDir: ca.defaultDir as string,
        autostart: ca.autostart as boolean,
      };
    })(),
```

- [ ] **Step 4: loadConfig 末尾日志加 codingAgent 配置**

定位 `loadConfig` 末尾 log（[electron/config.ts:411-415](electron/config.ts#L411-L415)）。在 `视图策略` log 后追加：

```ts
  log.info(`codingAgent: enable=${validated.codingAgent.enable}, autostart=${validated.codingAgent.autostart}, port=${validated.codingAgent.port}`);
```

- [ ] **Step 5: 验证 dev 模式跑得通**

Run: `npm run dev:offline`（仅 Vite，不走 Electron）

注意：dev 模式 cwd/config.jsonc 在仓库根；config.jsonc 现在还**没有** codingAgent 字段。预期：validateConfig 报「字段 codingAgent 缺失」并 process.exit(1)。这是预期的——Task 4 才补 config.jsonc。

按 ESC 退出 dev 模式。

- [ ] **Step 6: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: config.ts 加 codingAgent schema + 校验
【需求/缺陷单号】: 无
【修改内容】:
- AppConfig 加 codingAgent 嵌套对象（enable/binPath/installSource/port/defaultDir/autostart）
- validateConfig 新增 codingAgent 字段校验（嵌套字段全部必填）
- loadConfig 末尾 log 加 codingAgent 配置摘要
- 待 Task 4 补 config.jsonc 默认值后 dev 模式才能起
```

---

## Task 4: config.jsonc 默认值 + bundled 配置

**Files:**
- Modify: `config.jsonc`（仓库根，给 dev 模式用）
- Create: `config.jsonc`（如果不存在；从仓库根拷贝模板）

### Steps

- [ ] **Step 1: 检查仓库根 config.jsonc 是否已有 codingAgent**

Run: `grep -A 8 "codingAgent" config.jsonc` （若 grep 不可用则 Read 文件）

Expected: 不存在（v0.7.0 还没有此字段）

- [ ] **Step 2: 在文件末尾追加 codingAgent 默认值**

打开 `config.jsonc`，在最后一个 `}` 前一行追加（注意 JSONC 注释语法）：

```jsonc
  // opencode AI 编程助手集成（v1.1+）
  "codingAgent": {
    "enable": true,            // 总开关；false 时编码 tab 隐藏
    "binPath": "",             // 自定义 opencode 路径；空 = which/where 探测
    "installSource": "",       // 自定义安装源；v1.1 预留，默认走 npm i -g opencode-ai
    "port": 4296,              // opencode web 监听端口；占用时自动探测 4297-4300
    "defaultDir": "",          // opencode web 工作目录；空 = 平台默认
    "autostart": true          // macapp 启动时若 opencode 可用自动 spawn
  }
```

注意：JSONC 允许注释。确保 `,` 位置正确（前一字段后加逗号 + 新字段 + 末尾无逗号）。

- [ ] **Step 3: 验证 JSONC 格式合法**

Run: `node -e "const fs=require('fs'); const {parse}=require('jsonc-parser'); const t=fs.readFileSync('config.jsonc','utf-8'); const errs=[]; parse(t,errs,{allowTrailingComma:true}); if(errs.length) {console.error(errs); process.exit(1)} else console.log('OK')"`

Expected: `OK`

- [ ] **Step 4: 验证 dev 模式 Vite 编译通过**

Run: `npm run dev:offline`
Expected: Vite 启动无错误（dev 模式不读 config.jsonc，仅 Vite 编译）。Ctrl+C 退出。

- [ ] **Step 5: 验证 validateConfig 接受新字段（仅跑 validateConfig）**

Run: `node -e "const {validateConfig}=require('./dist-electron/config.js'); const r=validateConfig({targetUrl:'https://example.com',maxRetries:3,retryDelayMs:1000,minWidth:1,minHeight:1,width:100,height:100,autoUpdate:true,updateChannel:'stable',dismissCooldownHours:24,useOfflineFallback:true,codingAgent:{enable:true,binPath:'',installSource:'',port:4296,defaultDir:'',autostart:true}},'test'); console.log(JSON.stringify(r,null,2))"`

Expected: 输出包含 `"codingAgent": { "enable": true, ... "port": 4296, ... "autostart": true }`

注意：如果 `dist-electron/config.js` 不存在（未构建），改用：
```bash
npm run build:electron
```
然后再跑上面的 node -e。

- [ ] **Step 6: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: config.jsonc 加 codingAgent 默认值
【需求/缺陷单号】: 无
【修改内容】:
- config.jsonc 末尾追加 codingAgent 块（enable/binPath/installSource/port/defaultDir/autostart）
- 配合 Task 3 validateConfig 新校验，dev 模式可正常加载
```

---

## Task 5: codingAgent — detectNode()

**Files:**
- Modify: `electron/codingAgent.ts`（在类型定义后加 CodingAgent class 占位 + detectNode 私有方法）
- Create: `electron/codingAgent.test.ts`（行为文档）

### Steps

- [ ] **Step 1: 在 codingAgent.ts 加 detectNode 私有函数**

打开 [electron/codingAgent.ts](electron/codingAgent.ts)，在 CodingAgentConfig 接口后追加（类型定义外面，作为模块级私有函数）：

```ts
/**
 * 检测 Node.js + npm 是否可用。
 * 用 spawnSync 同步执行（用户首次点编码 tab 时的同步检测，<500ms 完成）。
 */
export function detectNode(): { ok: boolean; nodeVersion?: string; npmVersion?: string } {
  const node = spawnSync('node', ['--version'], { encoding: 'utf-8' });
  if (node.status !== 0 || !node.stdout) return { ok: false };
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf-8' });
  if (npm.status !== 0 || !npm.stdout) return { ok: false };
  return {
    ok: true,
    nodeVersion: node.stdout.trim(),
    npmVersion: npm.stdout.trim(),
  };
}
```

- [ ] **Step 2: 创建 electron/codingAgent.test.ts 行为文档**

```ts
// electron/codingAgent.test.ts
// 行为文档（待 vitest 接入后跑）。本文件不参与运行时编译——
// 命名 *.test.ts 由未来 vitest glob 自动跳过或纳入。

import { describe, it, expect, vi } from 'vitest'; // 未来引入时取消注释
import { detectNode } from './codingAgent';
import { spawnSync } from 'node:child_process';

// import { vi } from 'vitest';  // 未来引入时
vi.mock('node:child_process');

describe('detectNode', () => {
  it('returns ok=true when both node and npm are available', () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'v20.10.0\n' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '10.2.3\n' } as any);
    const result = detectNode();
    expect(result.ok).toBe(true);
    expect(result.nodeVersion).toBe('v20.10.0');
    expect(result.npmVersion).toBe('10.2.3');
  });

  it('returns ok=false when node is missing', () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 1, stdout: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '10.2.3\n' } as any);
    expect(detectNode().ok).toBe(false);
  });

  it('returns ok=false when npm is missing', () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: 'v20.10.0\n' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '' } as any);
    expect(detectNode().ok).toBe(false);
  });
});
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

Run: `npm run build:electron`
Expected: 编译成功。

如果报 `vi.mocked` / `describe` / `it` 未定义（因为没有装 vitest），说明测试文件被 tsc 纳入了。在 `tsconfig.json` 或 esbuild build 脚本中排除 `**/*.test.ts`。具体位置：
- 项目用 `scripts/build-electron.js` + esbuild，**通常 esbuild 默认不编译 `.test.ts`**，但保险起见检查 esbuild 配置入口（看是否有 `entryPoints` 列表）。
- 若 esbuild 把 .test.ts 纳入，临时方案：在 .test.ts 顶部加 `// @ts-nocheck` 绕过类型检查（运行时不会执行，因为没有 runner 调它）。

- [ ] **Step 4: 手动验证：开发机器上跑 detectNode**

Run: `node -e "const {detectNode} = require('./dist-electron/codingAgent.js'); console.log(detectNode())"`

Expected: 输出类似 `{ ok: true, nodeVersion: 'v20.x.x', npmVersion: '10.x.x' }`

- [ ] **Step 5: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: codingAgent detectNode() 实现 + 行为文档测试
【需求/缺陷单号】: 无
【修改内容】:
- electron/codingAgent.ts 加 detectNode()（spawnSync node --version + npm --version）
- electron/codingAgent.test.ts 加 detectNode 三个 case（行为文档，未跑）
```

---

## Task 6: codingAgent — pickPort() 端口探测

**Files:**
- Modify: `electron/codingAgent.ts`（加 pickPort + isPortFree 私有函数）

### Steps

- [ ] **Step 1: 在 codingAgent.ts 加 pickPort + isPortFree**

打开 [electron/codingAgent.ts](electron/codingAgent.ts)，在 `detectNode` 函数后追加：

```ts
/**
 * 探测单个端口是否空闲（仅 127.0.0.1）。
 * 用 net.createServer + listen 探测，close 后返回 true。
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 从 preferred 开始探测 range 个端口，返回第一个空闲端口；都占返回 null。
 */
export async function pickPort(preferred: number, range = 5): Promise<number | null> {
  for (let p = preferred; p < preferred + range; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}
```

- [ ] **Step 2: 在 codingAgent.test.ts 补 pickPort 测试用例**

打开 [electron/codingAgent.test.ts](electron/codingAgent.test.ts)，在最后一个 `});` 后追加：

```ts
import { pickPort, isPortFree } from './codingAgent';
import * as net from 'node:net';

describe('isPortFree', () => {
  it('returns true for an unbound port', async () => {
    const port = 40000 + Math.floor(Math.random() * 10000); // 动态端口避免冲突
    expect(await isPortFree(port)).toBe(true);
  });

  it('returns false when port is in use', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr && typeof addr === 'object') {
      expect(await isPortFree(addr.port)).toBe(false);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('pickPort', () => {
  it('returns preferred when free', async () => {
    const preferred = 50000 + Math.floor(Math.random() * 1000);
    expect(await pickPort(preferred, 3)).toBe(preferred);
  });

  it('skips occupied ports and returns next free', async () => {
    const preferred = 51000 + Math.floor(Math.random() * 1000);
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(preferred, '127.0.0.1', resolve));
    expect(await pickPort(preferred, 3)).toBe(preferred + 1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns null when all ports in range are occupied', async () => {
    const preferred = 52000 + Math.floor(Math.random() * 100);
    const servers: net.Server[] = [];
    for (let i = 0; i < 3; i++) {
      const s = net.createServer();
      await new Promise<void>((resolve) => s.listen(preferred + i, '127.0.0.1', resolve));
      servers.push(s);
    }
    expect(await pickPort(preferred, 3)).toBe(null);
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
```

- [ ] **Step 3: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

若 .test.ts 报错（缺 vitest 类型），按 Task 5 Step 3 同样处理：esbuild 不应纳入 .test.ts；若纳入则加 `// @ts-nocheck` 或调整 esbuild entry。

- [ ] **Step 4: 手动验证**

Run:
```bash
node -e "
(async () => {
  const { pickPort, isPortFree } = require('./dist-electron/codingAgent.js');
  console.log('isPortFree(4296):', await isPortFree(4296));
  console.log('pickPort(4296, 5):', await pickPort(4296, 5));
})()
"
```
Expected: 输出端口号（4296 或下一个空闲端口）。

- [ ] **Step 5: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: codingAgent pickPort() + isPortFree() 端口探测
【需求/缺陷单号】: 无
【修改内容】:
- electron/codingAgent.ts 加 isPortFree() + pickPort()（net.createServer 探测 127.0.0.1）
- codingAgent.test.ts 补 6 个端口探测 case（行为文档，未跑）
```

---

## Task 7: codingAgent — detect() 探测 opencode 可执行

**Files:**
- Modify: `electron/codingAgent.ts`（加 detectOpencode 私有函数）
- Modify: `electron/codingAgent.test.ts`（补 detect 用例）

### Steps

- [ ] **Step 1: 在 codingAgent.ts 加 detectOpencode**

打开 [electron/codingAgent.ts](electron/codingAgent.ts)，在 `pickPort` 函数后追加：

```ts
/**
 * 探测 opencode 是否已安装且可执行。
 *
 * 探测顺序：
 *   1) config.binPath 非空 → 直接用
 *   2) `which opencode`（macOS/Linux）/ `where opencode`（Windows）
 *   3) 都失败 → installed=false
 *
 * 返回 binPath 供后续 spawn 使用；version 通过 `opencode --version` 获取（仅日志用）。
 */
export async function detectOpencode(
  binPathOverride = '',
): Promise<{ installed: boolean; binPath?: string; version?: string }> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const candidates: string[] = [];
  if (binPathOverride) candidates.push(binPathOverride);
  // which/where 探测
  try {
    const whichResult = spawnSync(whichCmd, ['opencode'], { encoding: 'utf-8' });
    if (whichResult.status === 0 && whichResult.stdout) {
      // where 在 Windows 可能多行，取第一个非空行
      const firstLine = whichResult.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (firstLine) candidates.push(firstLine);
    }
  } catch {
    // 忽略
  }

  // 依次尝试
  for (const bin of candidates) {
    try {
      const verResult = spawnSync(bin, ['--version'], { encoding: 'utf-8' });
      if (verResult.status === 0) {
        return { installed: true, binPath: bin, version: verResult.stdout?.trim() };
      }
    } catch {
      continue;
    }
  }

  return { installed: false };
}
```

- [ ] **Step 2: 在 codingAgent.test.ts 补 detect 用例**

```ts
import { detectOpencode } from './codingAgent';

describe('detectOpencode', () => {
  it('returns installed=true with binPath when override path works', async () => {
    // 用 node 自己作为合法可执行模拟
    const result = await detectOpencode(process.execPath);
    expect(result.installed).toBe(true);
    expect(result.binPath).toBe(process.execPath);
  });

  it('returns installed=true when opencode is on PATH', async () => {
    // 此 case 依赖环境；存在时返回 true
    const result = await detectOpencode('');
    // 不做强制断言（CI 可能没装 opencode），只确认结构
    if (result.installed) {
      expect(result.binPath).toBeTruthy();
    } else {
      expect(result.installed).toBe(false);
    }
  });

  it('returns installed=false when override path is invalid', async () => {
    const result = await detectOpencode('/nonexistent/path/to/opencode-fake');
    expect(result.installed).toBe(false);
  });
});
```

- [ ] **Step 3: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

- [ ] **Step 4: 手动验证**

Run:
```bash
node -e "
(async () => {
  const { detectOpencode } = require('./dist-electron/codingAgent.js');
  console.log('detect (no override):', await detectOpencode(''));
  console.log('detect (fake override):', await detectOpencode('/no/such/path'));
})()
"
```
Expected: detect ('') 若装了 opencode → `{ installed: true, binPath: '...', version: '...' }`；否则 `{ installed: false }`。fake override 永远 false。

- [ ] **Step 5: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: codingAgent detectOpencode() 探测
【需求/缺陷单号】: 无
【修改内容】:
- electron/codingAgent.ts 加 detectOpencode()：override → which/where → 验证 --version
- codingAgent.test.ts 补 3 个 case（行为文档，未跑）
```

---

## Task 8: codingAgent — install() 静默 npm install

**Files:**
- Modify: `electron/codingAgent.ts`（加 install 私有函数）
- Modify: `electron/codingAgent.test.ts`（补 install 用例）

### Steps

- [ ] **Step 1: 在 codingAgent.ts 加 installOpencode**

打开 [electron/codingAgent.ts](electron/codingAgent.ts)，在 `detectOpencode` 函数后追加：

```ts
/**
 * 静默安装 opencode-ai（npm i -g）。
 * 走默认源；installSource 字段本期不解析（v1.1 预留）。
 *
 * 返回 ok=false 时，stderr 取末尾 200 字作为 message 给 UI 提示。
 */
export async function installOpencode(): Promise<{ ok: boolean; stderr?: string }> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', 'opencode-ai'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
      // 保留末尾 200 字用于报错展示
      if (stderrBuf.length > 200) {
        stderrBuf = stderrBuf.slice(-200);
      }
    });
    // 吞掉 stdout（npm install 输出很啰嗦）
    child.stdout.on('data', () => {});

    child.on('error', (err) => {
      resolve({ ok: false, stderr: err.message });
    });
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, stderr: stderrBuf || `npm install exited with code ${code}` });
    });
  });
}
```

- [ ] **Step 2: 在 codingAgent.test.ts 补 install 用例**

```ts
import { installOpencode } from './codingAgent';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  stdout = new EventEmitter();
}

describe('installOpencode', () => {
  it('returns ok=true when npm exits with code 0', async () => {
    const fake = new FakeChild();
    vi.mocked(spawn).mockReturnValue(fake as any);
    const promise = installOpencode();
    setImmediate(() => fake.emit('exit', 0));
    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with stderr when npm exits non-zero', async () => {
    const fake = new FakeChild();
    vi.mocked(spawn).mockReturnValue(fake as any);
    const promise = installOpencode();
    setImmediate(() => {
      fake.stderr.emit('data', Buffer.from('EACCES: permission denied'));
      fake.emit('exit', 1);
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('EACCES');
  });

  it('returns ok=false with error message when spawn errors', async () => {
    const fake = new FakeChild();
    vi.mocked(spawn).mockReturnValue(fake as any);
    const promise = installOpencode();
    setImmediate(() => fake.emit('error', new Error('spawn ENOENT')));
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('spawn ENOENT');
  });
});
```

- [ ] **Step 3: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

- [ ] **Step 4: 手动验证（**慎用，会真的装**）**

如果本机没装 opencode，可跑：
```bash
node -e "
(async () => {
  const { installOpencode } = require('./dist-electron/codingAgent.js');
  const r = await installOpencode();
  console.log('install result:', r);
})()
```
如果已装，可跳过此步骤（避免重复安装浪费时间）。

- [ ] **Step 5: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: codingAgent installOpencode() npm 静默安装
【需求/缺陷单号】: 无
【修改内容】:
- electron/codingAgent.ts 加 installOpencode()（spawn npm install -g opencode-ai，stderr 末尾 200 字）
- codingAgent.test.ts 补 3 个 case（行为文档，未跑）
```

---

## Task 9: codingAgent — CodingAgent class + 状态机 + emit

**Files:**
- Modify: `electron/codingAgent.ts`（加 CodingAgent class）

### Steps

- [ ] **Step 1: 在 codingAgent.ts 末尾追加 CodingAgent class**

打开 [electron/codingAgent.ts](electron/codingAgent.ts)，在 `installOpencode` 函数后追加：

```ts
/**
 * codingAgent 单例模块。
 *
 * 设计要点：
 * - 状态机内部维护唯一 source of truth（status 字段），通过 `emit()` 推给所有监听者。
 * - 监听者通过 subscribe() 注册；调用方在 main.ts 中用 webContents.send('coding:status', payload) 转发给 renderer。
 * - tryAutostart() 由 app.whenReady().then 的 setImmediate 调用。
 * - shutdown() 由 app.before-quit 调用，同步阻塞 ≤2s。
 */
export class CodingAgent {
  private status: CodingStatus = { state: 'unavailable' };
  private child: ChildProcess | null = null;
  private cfg: CodingAgentConfig | null = null;
  private port: number | null = null;
  private listeners = new Set<(s: CodingStatus) => void>();

  /** 订阅 status 变化；返回 unsubscribe。 */
  subscribe(cb: (s: CodingStatus) => void): () => void {
    this.listeners.add(cb);
    // 立刻推一次当前状态（让新订阅者拿到初始值）
    cb(this.status);
    return () => this.listeners.delete(cb);
  }

  /** 推送状态变更 + 通知所有订阅者 */
  private emit(next: CodingStatus): void {
    this.status = next;
    log.info(`status → ${next.state}`);
    for (const cb of this.listeners) {
      try {
        cb(next);
      } catch (err) {
        log.error(`listener threw: ${(err as Error).message}`);
      }
    }
  }

  getStatus(): CodingStatus {
    return this.status;
  }

  /** 给 renderer 的 init IPC（首次订阅时获取初始状态）使用 */
  getInitialStatus(): CodingStatus {
    return this.status;
  }

  /** 设置 config（在 app.whenReady 内调用一次） */
  configure(cfg: CodingAgentConfig): void {
    this.cfg = cfg;
  }
}

/** 单例导出 */
export const codingAgent = new CodingAgent();
```

- [ ] **Step 2: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

- [ ] **Step 3: 手动验证状态机**

Run:
```bash
node -e "
const { codingAgent } = require('./dist-electron/codingAgent.js');
codingAgent.configure({enable:true,binPath:'',installSource:'',port:4296,defaultDir:'',autostart:true});
const unsub = codingAgent.subscribe(s => console.log('listener got:', s.state));
unsub();
console.log('initial:', codingAgent.getStatus().state);
"
```
Expected: `listener got: unavailable`（初始推一次） + `initial: unavailable`。

- [ ] **Step 4: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: codingAgent CodingAgent class + 状态机 + 订阅
【需求/缺陷单号】: 无
【修改内容】:
- electron/codingAgent.ts 加 CodingAgent class + codingAgent 单例
- 状态机：emit() 唯一入口，subscribe() 返回 unsubscribe
- configure() 注入 config；getStatus() / getInitialStatus() 暴露当前状态
```

---

## Task 10: codingAgent — spawn() + healthCheck()

**Files:**
- Modify: `electron/codingAgent.ts`（在 CodingAgent class 加 spawn + healthCheck）

### Steps

- [ ] **Step 1: 加 spawnOpencode + healthCheck 私有方法**

打开 [electron/codingAgent.ts](electron/codingAgent.ts)，在 `CodingAgent` class 内 `configure(cfg)` 方法后追加：

```ts
  /**
   * spawn `opencode web --port <port> --hostname 127.0.0.1`。
   * 返回 ok=false 时，message 给 UI 提示。
   * spawn 成功后会启 healthCheck 轮询（5s timeout）。
   */
  private async spawnOpencode(binPath: string): Promise<{ ok: boolean; url?: string; message?: string }> {
    if (!this.cfg) return { ok: false, message: 'codingAgent not configured' };

    const port = await pickPort(this.cfg.port, 5);
    if (port === null) {
      return { ok: false, message: `无可用端口（${this.cfg.port} ~ ${this.cfg.port + 4} 全被占用）` };
    }
    this.port = port;

    const cwd = this.resolveDefaultDir();
    const args = ['web', '--port', String(port), '--hostname', '127.0.0.1'];
    log.info(`spawn: ${binPath} ${args.join(' ')} cwd=${cwd}`);

    try {
      this.child = spawn(binPath, args, {
        cwd,
        env: { ...process.env, OPENCODE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (err) {
      return { ok: false, message: `spawn 失败: ${(err as Error).message}` };
    }

    // stdout/stderr 接 logger
    this.child.stdout?.on('data', (chunk: Buffer) => {
      log.debug(`opencode stdout: ${chunk.toString('utf-8').trim()}`);
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      log.debug(`opencode stderr: ${chunk.toString('utf-8').trim()}`);
    });

    // 进程退出监听
    this.child.on('exit', (code, signal) => {
      log.warn(`opencode exited: code=${code} signal=${signal ?? 'null'}`);
      this.child = null;
      if (this.status.state !== 'unavailable') {
        if (code === 0 || code === null) {
          // before-quit 主动 kill → 静默回到 unavailable
          this.emit({ state: 'unavailable' });
        } else {
          this.emit({ state: 'exited', code: code ?? -1, signal: signal ?? undefined });
        }
      }
    });

    this.emit({ state: 'spawning' });

    // health check：轮询 http://127.0.0.1:<port>/，5s timeout
    const ready = await this.healthCheck(port, 5000);
    if (!ready) {
      this.killChild();
      this.emit({ state: 'timeout' });
      return { ok: false, message: 'opencode 启动超时（5s 未就绪）' };
    }

    const url = `http://127.0.0.1:${port}`;
    this.emit({ state: 'ready', url });
    return { ok: true, url };
  }

  /**
   * 轮询 http://127.0.0.1:<port>/，每 200ms 一次，最多 timeoutMs。
   * 2xx 响应即视为就绪。
   */
  private async healthCheck(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        if (res.ok) return true;
      } catch {
        // 未就绪或 ECONNREFUSED，继续轮询
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  /** 解析 defaultDir；空时用平台默认；不存在时 fallback 到 home */
  private resolveDefaultDir(): string {
    if (!this.cfg) return os.homedir();
    const cfgDir = this.cfg.defaultDir.trim();
    if (cfgDir) {
      // require 在方法内避免循环依赖（仅运行时触发）
      const fs = require('node:fs') as typeof import('node:fs');
      if (fs.existsSync(cfgDir)) return cfgDir;
      log.warn(`codingAgent.defaultDir 不存在: ${cfgDir}，fallback 到平台默认`);
    }
    if (process.platform === 'darwin') {
      const docs = path.join(os.homedir(), 'Documents');
      const fs = require('node:fs') as typeof import('node:fs');
      if (fs.existsSync(docs)) return docs;
    }
    return os.homedir();
  }

  /** 同步 kill 子进程（before-quit 用） */
  private killChild(): void {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGTERM');
      } catch (err) {
        log.error(`kill failed: ${(err as Error).message}`);
      }
    }
  }
```

- [ ] **Step 2: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

- [ ] **Step 3: 手动验证（**需要 opencode**）**

如果本机装了 opencode：
```bash
node -e "
const { codingAgent } = require('./dist-electron/codingAgent.js');
codingAgent.configure({enable:true,binPath:'',installSource:'',port:4296,defaultDir:'',autostart:false});
codingAgent.subscribe(s => console.log('status:', s.state, s.url || ''));
codingAgent['spawnOpencode']('<binPath>').then(r => console.log('result:', r));
"
```
其中 `<binPath>` 替换为 `which opencode` 的输出。

Expected: `status: spawning` → `status: ready http://127.0.0.1:4296` → `result: { ok: true, url: '...' }`

跑完后 Ctrl+C 退出，opencode 子进程会保留（这是手动测试场景）；通过 `kill <pid>` 清理。

- [ ] **Step 4: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: codingAgent spawnOpencode + healthCheck + resolveDefaultDir
【需求/缺陷单号】: 无
【修改内容】:
- CodingAgent class 加 spawnOpencode / healthCheck / resolveDefaultDir / killChild 私有方法
- spawn args: web --port <port> --hostname 127.0.0.1；端口探测失败 → spawn-failed
- healthCheck 5s timeout，轮询 200ms
- exit handler：code !== 0 → 推 exited；code === 0/null → 推 unavailable（区分主动 kill vs 异常退出）
```

---

## Task 11: codingAgent — handleOpen / handleRetry / tryAutostart / shutdown

**Files:**
- Modify: `electron/codingAgent.ts`（在 CodingAgent class 加公开方法）

### Steps

- [ ] **Step 1: 加 handleOpen / handleRetry / tryAutostart / shutdown**

打开 [electron/codingAgent.ts](electron/codingAgent.ts)，在 `killChild` 方法后追加：

```ts
  /**
   * 用户点编码 tab → 主进程按需安装+spawn。
   * 返回 CodingOpenResult；同时通过 emit() 推送 status 给 renderer。
   */
  async handleOpen(): Promise<CodingOpenResult> {
    if (!this.cfg || !this.cfg.enable) {
      return { ok: false, reason: 'spawn-failed', message: 'codingAgent 已禁用' };
    }

    const current = this.status.state;

    // 已 ready：直接返回 url（主进程 codingView 切换由 IPC handler 触发，见 Task 13）
    if (current === 'ready') {
      return { ok: true, url: (this.status as { state: 'ready'; url: string }).url };
    }

    // spawning：等就绪后返回 url
    if (current === 'spawning') {
      const ready = await this.waitForState('ready', 8000);
      if (ready) {
        return { ok: true, url: (this.status as { state: 'ready'; url: string }).url };
      }
      return { ok: false, reason: 'timeout', message: 'opencode 启动超时' };
    }

    // 其他状态（unavailable / spawn-failed / timeout / exited）→ install 路径
    return this.installAndStart();
  }

  /**
   * 用户在 coding:status 推 exited / spawn-failed / timeout 后点重试。
   */
  async handleRetry(): Promise<CodingOpenResult> {
    return this.installAndStart();
  }

  /**
   * macapp 启动期调用：autostart=true 时尝试 spawn 已装 opencode。
   * spawn 失败仅记日志，不影响主流程。
   */
  async tryAutostart(): Promise<void> {
    if (!this.cfg || !this.cfg.enable || !this.cfg.autostart) return;

    const detect = await detectOpencode(this.cfg.binPath);
    if (!detect.installed) {
      log.info('opencode not installed, skip autostart');
      this.emit({ state: 'unavailable' });
      return;
    }
    log.info(`autostart: detected ${detect.binPath} version=${detect.version}`);
    const result = await this.spawnOpencode(detect.binPath);
    if (!result.ok) {
      log.error(`autostart spawn failed: ${result.message}`);
      this.emit({ state: 'spawn-failed', message: result.message ?? 'unknown' });
    }
  }

  /** before-quit 同步阻塞回收 opencode 进程（≤2s） */
  shutdown(): void {
    if (!this.child || this.child.killed) return;
    log.info('shutdown: killing opencode child');
    this.killChild();
    // 同步等 exit（≤2s）
    const start = Date.now();
    while (this.child && !this.child.killed && Date.now() - start < 2000) {
      // busy-wait 200ms 步进（避免 100% CPU）
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin */ }
    }
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }

  /**
   * install + spawn 全流程（handleOpen / handleRetry 共用）。
   */
  private async installAndStart(): Promise<CodingOpenResult> {
    // ① Node.js 检测
    const node = detectNode();
    if (!node.ok) {
      this.emit({ state: 'spawn-failed', message: '请先安装 Node.js（含 npm）' });
      return { ok: false, reason: 'no-node', message: '请先安装 Node.js（含 npm）→ nodejs.org' };
    }

    // ② 静默安装
    this.emit({ state: 'installing' });
    const install = await installOpencode();
    if (!install.ok) {
      this.emit({ state: 'spawn-failed', message: install.stderr ?? 'install failed' });
      return { ok: false, reason: 'install-failed', message: install.stderr ?? 'install failed' };
    }

    // ③ 重新 detect + spawn
    const detect = await detectOpencode(this.cfg?.binPath ?? '');
    if (!detect.installed) {
      this.emit({ state: 'spawn-failed', message: '安装后仍找不到 opencode' });
      return { ok: false, reason: 'still-missing', message: '安装后仍检测不到 opencode 命令' };
    }
    const spawnResult = await this.spawnOpencode(detect.binPath!);
    if (!spawnResult.ok) {
      return { ok: false, reason: 'spawn-failed', message: spawnResult.message ?? 'unknown' };
    }
    return { ok: true, url: spawnResult.url! };
  }

  /**
   * 等状态变成 target，最长 timeoutMs。
   */
  private waitForState(target: CodingStatus['state'], timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.status.state === target) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        unsub();
        resolve(false);
      }, timeoutMs);
      const unsub = this.subscribe((s) => {
        if (s.state === target) {
          clearTimeout(timer);
          unsub();
          resolve(true);
        }
      });
    });
  }
```

- [ ] **Step 2: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

- [ ] **Step 3: 手动验证 tryAutostart（需要装了 opencode）**

Run:
```bash
node -e "
const { codingAgent } = require('./dist-electron/codingAgent.js');
codingAgent.configure({enable:true,binPath:'',installSource:'',port:4296,defaultDir:'',autostart:true});
codingAgent.subscribe(s => console.log('status:', s.state));
codingAgent.tryAutostart().then(() => {
  console.log('autostart done');
  setTimeout(() => process.exit(0), 1000); // 1s 后退出看 exit handler
});
"
```
Expected: `status: spawning` → `status: ready http://127.0.0.1:4296` → `autostart done` → 进程退出。

- [ ] **Step 4: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: codingAgent 公开 API（handleOpen/handleRetry/tryAutostart/shutdown）+ installAndStart
【需求/缺陷单号】: 无
【修改内容】:
- handleOpen 决策树：ready 直接返回；spawning 等就绪；其他走 install
- handleRetry = installAndStart
- tryAutostart 在 app.whenReady 内的 setImmediate 调用
- shutdown 同步阻塞 2s（SIGTERM → SIGKILL）
- installAndStart 全流程：detectNode → installOpencode → detect → spawn
- waitForState 私有方法用于 spawning 等就绪
```

---

## Task 12: main.ts 集成 — autostart + before-quit + codingView

**Files:**
- Modify: `electron/main.ts`（加 setImmediate + before-quit + codingView 创建）

### Steps

- [ ] **Step 1: 顶部加 codingAgent import**

打开 [electron/main.ts:1-11](electron/main.ts#L1-L11)，在 logger import 后追加：

```ts
import { codingAgent } from './codingAgent';
```

- [ ] **Step 2: 加 codingView 全局变量 + showOnly/allViews 改造**

定位 `let contentView: WebContentsView | null = null;` 后（[electron/main.ts:21](electron/main.ts#L21)）追加：

```ts
let codingView: WebContentsView | null = null;
```

定位 `showOnly` 函数（[electron/main.ts:30-36](electron/main.ts#L30-L36)），加一行：

```ts
  codingView?.setVisible(view === codingView);
```

定位 `allViews` 函数（[electron/main.ts:39-43](electron/main.ts#L39-L43)），加一项：

```ts
    codingView,
```

- [ ] **Step 3: 加 createCodingView 函数**

定位 `createUrlView` 函数（[electron/main.ts:89-104](electron/main.ts#L89-L104)）后追加：

```ts
/** 创建一个 codingView，加载 opencode web UI（127.0.0.1:<port>） */
function createCodingView(url: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 本地可信端口
    },
  });
  const [w, h] = mainWindow!.getContentSize();
  view.setBounds({ x: 0, y: 0, width: w, height: h });
  view.webContents.loadURL(url);
  mainWindow!.contentView.addChildView(view);
  view.setVisible(false);

  // 导航白名单：仅允许本会话的 127.0.0.1:<port>
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https:')) shell.openExternal(target);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      log.warn(`codingView will-navigate blocked: ${target}`);
    }
  });
  return view;
}

/** codingView 加载完成后切到 codingView；懒加载（仅在用户首次进入编码页时创建） */
function showCodingView(url: string): void {
  if (!codingView) {
    codingView = createCodingView(url);
  } else {
    // 已有 view → reload 加载新 url（端口变化场景）
    codingView.webContents.loadURL(url);
  }
  showOnly(codingView);
}
```

- [ ] **Step 4: 在 app.whenReady 内加 setImmediate + codingAgent.configure**

定位 `app.whenReady().then(async () => { ... })`（[electron/main.ts:370-399](electron/main.ts#L370-L399)）。在 `createMainWindow(config);` 后追加：

```ts
  // v1.1: 配置 codingAgent + 启动期 autostart
  codingAgent.configure(config.codingAgent);
  setImmediate(() => {
    codingAgent.tryAutostart().catch((err) => {
      log.error(`codingAgent tryAutostart failed: ${(err as Error).message}`);
    });
  });
```

- [ ] **Step 5: 在 before-quit 加 shutdown**

定位 `app.on('before-quit', ...)`（[electron/main.ts:401-404](electron/main.ts#L401-L404)）：

```ts
app.on('before-quit', () => {
  log.info('app quitting');
  codingAgent.shutdown(); // v1.1: kill opencode 进程（同步阻塞 ≤2s）
  closeLogger();
});
```

注意顺序：先 shutdown（kill 进程 → 释放端口），再 closeLogger（刷盘日志）。spec §5.6 要求。

- [ ] **Step 6: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

- [ ] **Step 7: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: main.ts 集成 codingAgent（autostart + shutdown + codingView）
【需求/缺陷单号】: 无
【修改内容】:
- 顶部 import codingAgent
- codingView 全局变量 + showOnly 加 codingView 分支 + allViews 加 codingView
- createCodingView(url) + showCodingView(url)：懒加载、导航白名单仅本会话端口
- app.whenReady 内 setImmediate(codingAgent.tryAutostart)
- before-quit 先 codingAgent.shutdown() 再 closeLogger()
```

---

## Task 13: main.ts — 注册 coding IPC handlers

**Files:**
- Modify: `electron/main.ts`（registerIpcHandlers 末尾追加）

### Steps

- [ ] **Step 1: 加 IPC handler 推送 status 给 renderer**

打开 [electron/main.ts](electron/main.ts)，定位 `registerIpcHandlers(mode)` 函数（[electron/main.ts:344-367](electron/main.ts#L344-L367)）。在函数末尾（`}` 之前）追加：

```ts
  // v1.1: coding IPC handlers（不依赖 mode，两个模式都注册）
  // open: 用户点编码 tab → handleOpen；成功时主进程自动切 codingView
  ipcMain.handle('coding:open', async () => {
    const result = await codingAgent.handleOpen();
    if (result.ok) {
      showCodingView(result.url);
    }
    return result;
  });

  // close: 切回 offlineView（不杀进程）
  ipcMain.handle('coding:close', () => {
    const offlineV = offlineView ?? contentView; // legacy 模式没有 offlineView
    showOnly(offlineV);
  });

  // status: 渲染端首次订阅时获取初始状态
  ipcMain.handle('coding:status', () => codingAgent.getInitialStatus());

  // retry: 异常后用户点重试
  ipcMain.handle('coding:retry', async () => {
    const result = await codingAgent.handleRetry();
    if (result.ok) {
      showCodingView(result.url);
    }
    return result;
  });

  // 状态变更推送（onStatus 订阅）：codingAgent.subscribe → 所有 webContents.send
  codingAgent.subscribe((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('coding:status', status);
    }
  });
```

- [ ] **Step 2: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

注意：`BrowserWindow.getAllWindows()` 在 registerIpcHandlers 调用时还没有 window（时序在 createMainWindow 之前）；subscribe 仍然能注册，只是 BrowserWindow.getAllWindows() 返回空数组。后续 window 创建后 push 事件不会被转发——这是已知 limitation，renderer 在 onStatus 订阅时会主动调 coding:status 拿初始值补齐。

- [ ] **Step 3: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: main.ts coding IPC handlers（open/close/status/retry）+ status 推送订阅
【需求/缺陷单号】: 无
【修改内容】:
- registerIpcHandlers 末尾追加 coding:open / coding:close / coding:status / coding:retry
- coding:open 成功时主进程 showCodingView 自动切 view（spec §3.1 view 切换归属）
- codingAgent.subscribe → 所有 BrowserWindow webContents.send('coding:status')
- 已知 limitation：subscribe 在 window 创建前注册，初始状态丢失；renderer 通过 coding:status IPC 补
```

---

## Task 14: preload.ts — coding API namespace

**Files:**
- Modify: `electron/preload.ts`（在 contextBridge 内加 coding 命名空间）

### Steps

- [ ] **Step 1: 在 electronAPI 加 coding 字段**

打开 [electron/preload.ts](electron/preload.ts)，在 `updater: { ... },` 后（[electron/preload.ts:62](electron/preload.ts#L62) 末尾 `},` 前）追加：

```ts
  coding: {
    /**
     * 用户点编码 tab → 主进程按需安装+spawn。
     * 返回 ok=true 时 url 是 opencode web 入口；主进程已自动切 codingView。
     * 返回 ok=false 时 reason + message 提示具体原因。
     */
    open: (): Promise<{ ok: boolean; url?: string; reason?: string; message?: string }> =>
      ipcRenderer.invoke('coding:open'),
    /** 关闭编码页 → 主进程 showOnly(offlineView)；不杀进程 */
    close: (): void => {
      ipcRenderer.send('coding:close');
    },
    /** 获取初始状态（renderer 首次订阅时主动调一次） */
    getInitialStatus: (): Promise<CodingStatus> => ipcRenderer.invoke('coding:status'),
    /** 订阅 status 变化；返回 unsubscribe */
    onStatus: (cb: (status: CodingStatus) => void): (() => void) => {
      const listener = (_e: unknown, status: CodingStatus) => cb(status);
      ipcRenderer.on('coding:status', listener);
      return () => ipcRenderer.removeListener('coding:status', listener);
    },
    /** 异常退出 / spawn 失败后用户点重试 */
    retry: (): Promise<{ ok: boolean; url?: string; message?: string }> =>
      ipcRenderer.invoke('coding:retry'),
  },
```

- [ ] **Step 2: 顶部加 CodingStatus 类型 import**

打开 [electron/preload.ts:1](electron/preload.ts#L1)，在 `import { contextBridge, ipcRenderer } from 'electron';` 后追加：

```ts
import type { CodingStatus } from './codingAgent';
```

- [ ] **Step 3: 编译验证**

Run: `npm run build:electron`
Expected: 编译成功。

- [ ] **Step 4: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: preload coding namespace API
【需求/缺陷单号】: 无
【修改内容】:
- electron/preload.ts 加 coding.open/close/getInitialStatus/onStatus/retry
- onStatus 返回 unsubscribe 函数（与 online:loading 模式一致）
- import CodingStatus 类型自 ./codingAgent
```

---

## Task 15: offline-app — coding-toast.ts

**Files:**
- Create: `offline-app/src/coding-toast.ts`

### Steps

- [ ] **Step 1: 创建 coding-toast.ts**

```ts
// offline-app/src/coding-toast.ts
/**
 * codingAgent 状态变更的 UI 反馈。
 * 复用 Element Plus 现有组件：
 * - ElMessage：轻提示（安装中、启动中、错误）
 * - ElNotification：强提示（缺 Node.js，带操作链接）
 */

import { ElMessage, ElNotification } from 'element-plus';
import type { CodingStatus } from '@/types/coding';

/**
 * 根据 status 推送 toast。
 * - ready：closeAll（关闭 installing/spawning 的持续 toast）
 * - exited / spawn-failed / timeout：error toast
 * - installing / spawning：info 持续 toast
 */
export function codingToast(status: CodingStatus): void {
  switch (status.state) {
    case 'installing':
      ElMessage.info({ message: '正在安装 opencode…', duration: 0, grouping: true });
      break;
    case 'spawning':
      ElMessage.info({ message: '正在启动 opencode…', duration: 0, grouping: true });
      break;
    case 'ready':
      ElMessage.closeAll();
      break;
    case 'exited':
      ElMessage.error(`opencode 已退出（code=${status.code}）`);
      break;
    case 'spawn-failed':
      ElMessage.error(`opencode 启动失败：${status.message}`);
      break;
    case 'timeout':
      ElMessage.error('opencode 启动超时');
      break;
    case 'unavailable':
      // 静默（用户首次点 tab 之前不应有 unavailable 提示）
      break;
  }
}

/**
 * Node.js 缺失的强提示（带「打开 nodejs.org」操作链接）。
 */
export function notifyNoNode(message: string): void {
  ElNotification({
    title: '需要 Node.js',
    message,
    duration: 0, // 不自动关
    type: 'warning',
    // 注：v1.1 不实现「打开 nodejs.org」按钮（避免引入额外 IPC），等 M3 再加
  });
}
```

- [ ] **Step 2: 验证 vite 编译通过**

Run: `npm run build:offline`
Expected: 编译成功，无 TS 错误。

- [ ] **Step 3: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: offline-app coding-toast 工具（ElMessage + ElNotification）
【需求/缺陷单号】: 无
【修改内容】:
- 新增 offline-app/src/coding-toast.ts
- codingToast(status) 处理 7 种状态（installing/spawning/ready/exited/spawn-failed/timeout/unavailable）
- notifyNoNode(message) 用于缺 Node.js 的强提示
```

---

## Task 16: ui store — coding 状态订阅

**Files:**
- Modify: `offline-app/src/stores/ui.ts`（加 codingStatus + isInCodingView + 订阅）

### Steps

- [ ] **Step 1: 顶部加 import**

打开 [offline-app/src/stores/ui.ts:1-3](offline-app/src/stores/ui.ts#L1-L3)，在 `import { aiApps, bottomTabs } from '@/data/assistantFeatures';` 后追加：

```ts
import type { CodingStatus } from '@/types/coding';
import { codingToast } from '@/coding-toast';
```

- [ ] **Step 2: 加 codingStatus + isInCodingView ref + setter**

打开 [offline-app/src/stores/ui.ts:9](offline-app/src/stores/ui.ts#L9)，定位 `useUiStore` 定义。在 `hasReceivedFirstEvent` ref 后追加：

```ts
  /**
   * codingAgent 当前状态（与 main process 同步）。
   * 用于 BottomTabBar/FeatureCard 的视觉态（灰显、loading）。
   */
  const codingStatus = ref<CodingStatus>({ state: 'unavailable' });
  /**
   * 当前是否在 codingView（用于 Tab 高亮）。
   * 暂未在 UI 启用，预留给 M3 返回按钮 overlay。
   */
  const isInCodingView = ref(false);
```

- [ ] **Step 3: 在 retryOnline 函数后追加 setCodingStatus / setInCodingView**

定位 `retryOnline` 函数（[offline-app/src/stores/ui.ts:50-56](offline-app/src/stores/ui.ts#L50-L56)），在其后追加：

```ts
  function setCodingStatus(s: CodingStatus): void {
    codingStatus.value = s;
  }
  function setInCodingView(v: boolean): void {
    isInCodingView.value = v;
  }
```

- [ ] **Step 4: 加 onStatus 订阅 + HMR 清理**

定位 `if (window.electronAPI) { const unsubscribe = ... }` 块（[offline-app/src/stores/ui.ts:67-76](offline-app/src/stores/ui.ts#L67-L76)），在该块后追加（注意：HMR dispose 也要叠加）：

```ts
  /** 订阅 coding:status 推送（HMR 清理沿用 online:loading 模式） */
  if (window.electronAPI) {
    // 先拿一次初始状态（处理 subscribe 在 window 创建前注册的 edge case）
    window.electronAPI.coding.getInitialStatus().then((s) => {
      codingStatus.value = s;
    });

    const unsubscribeCoding = window.electronAPI.coding.onStatus((s) => {
      codingStatus.value = s;
      codingToast(s); // 自动 toast 反馈
    });
    if (import.meta.hot) {
      import.meta.hot.dispose(() => unsubscribeCoding());
    }
  }
```

- [ ] **Step 5: 在 return 中暴露新字段**

定位 `return { ... }`（[offline-app/src/stores/ui.ts:78-89](offline-app/src/stores/ui.ts#L78-L89)），在 `retryOnline,` 后追加：

```ts
    codingStatus,
    isInCodingView,
    setCodingStatus,
    setInCodingView,
```

- [ ] **Step 6: 验证 vite 编译通过**

Run: `npm run build:offline`
Expected: 编译成功。

- [ ] **Step 7: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: ui store 加 coding 状态字段 + onStatus 订阅
【需求/缺陷单号】: 无
【修改内容】:
- codingStatus / isInCodingView ref + setter
- onStatus 订阅：自动 codingToast + 更新 codingStatus
- getInitialStatus IPC 兜底 subscribe 时序 edge case
- HMR 清理沿用现有 import.meta.hot.dispose 模式
```

---

## Task 17: assistantFeatures.ts — 写代码卡加 action

**Files:**
- Modify: `offline-app/src/data/assistantFeatures.ts`（FeatureCard 加 action 字段 + 给写代码卡赋值）

### Steps

- [ ] **Step 1: FeatureCard 接口加 action 字段**

打开 [offline-app/src/data/assistantFeatures.ts:21-30](offline-app/src/data/assistantFeatures.ts#L21-L30)，定位 `FeatureCard` 接口。在 `iconBg: string;` 后追加：

```ts
  /** 卡片特殊行为；不填或 null = 占位 console.log */
  action?: 'coding' | null;
```

- [ ] **Step 2: 给「写代码」卡片加 action**

定位「算粒写」section 的「写代码」卡片（[offline-app/src/data/assistantFeatures.ts:63-67](offline-app/src/data/assistantFeatures.ts#L63-L67)），在 `iconBg: '#dbeafe', // bg-blue-100` 后加一行：

```ts
        action: 'coding',
```

完整卡片对象：
```ts
      {
        title: '写代码',
        desc: '快速编写代码',
        icon: '💻',
        iconBg: '#dbeafe', // bg-blue-100
        action: 'coding',
      },
```

- [ ] **Step 3: 验证 vite 编译**

Run: `npm run build:offline`
Expected: 编译成功。

- [ ] **Step 4: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: FeatureCard 加 action 字段 + 「写代码」卡片标记
【需求/缺陷单号】: 无
【修改内容】:
- offline-app/src/data/assistantFeatures.ts FeatureCard 加 action?: 'coding' | null
- 「写代码」卡片加 action: 'coding'（App.vue 据此走 onCodeClick 而非 console.log 占位）
```

---

## Task 18: App.vue — onCodeClick handler 接通

**Files:**
- Modify: `offline-app/src/App.vue`（替换 console.log 占位 → onCodeClick）

### Steps

- [ ] **Step 1: 顶部加 import**

打开 [offline-app/src/App.vue:1-10](offline-app/src/App.vue#L1-L10)，定位 `<script setup lang="ts">`。在 `import { useUiStore } from '@/stores/ui';` 后追加：

```ts
import { storeToRefs } from 'pinia';
import { onMounted } from 'vue';
```

- [ ] **Step 2: 加 onCodeClick 函数 + dev 模式 fallback**

定位 `function onMore()`（[offline-app/src/App.vue:22](offline-app/src/App.vue#L22)）后追加：

```ts
/**
 * 写代码卡片 / tab 点击：统一调 codingAgent.open()。
 * 主进程会处理 install + spawn + view 切换，前端只需触发。
 * dev 模式无 IPC，仅 console.log 占位。
 */
function onCodeClick() {
  if (window.electronAPI) {
    window.electronAPI.coding.open().then((result) => {
      if (!result.ok) {
        // 错误已由主进程通过 toast 反馈；前端无操作
        console.warn('[coding] open failed:', result.reason, result.message);
      }
    });
  } else {
    console.log('coding click (dev mode, no IPC)');
  }
}

/** 暴露给模板：判断卡片是否触发 coding 行为 */
function isCodeCard(action?: 'coding' | null): boolean {
  return action === 'coding';
}
```

- [ ] **Step 3: 改造 FeatureSection 卡片 click 处理**

打开 [offline-app/src/App.vue](offline-app/src/App.vue)，定位 `App.vue:34-45` 的 `<main class="main">` 块。在 `FeatureSection` 块上加 `@card-click` 事件（需要在 FeatureSection.vue 加 emit）—— 或者更简单：在 App.vue 用 v-for 自己渲染卡片。

更简单的方案：直接修改 FeatureSection 的卡片 click 走 store 里的某 action，再由 App.vue 注入 onCodeClick。但这要改 FeatureSection.vue。

**最简方案**：在 App.vue 替换 FeatureSection 卡片为直接渲染，绕过 FeatureSection.vue 的封装。打开 `<FeatureSection ... />` 这一行（[offline-app/src/App.vue:40-45](offline-app/src/App.vue#L40-L45)），替换为：

```vue
      <!-- 三大功能区块（写代码卡片点击触发 codingAgent，其余走占位） -->
      <div class="sections">
        <div v-for="section in featureSections" :key="section.id" class="section-block">
          <div class="section-header">
            <span class="section-header-icon">{{ section.headerIcon }}</span>
            <div>
              <div class="section-title">{{ section.title }}</div>
              <div class="section-subtitle">{{ section.subtitle }}</div>
            </div>
          </div>
          <div class="section-cards">
            <div
              v-for="card in section.cards"
              :key="card.title"
              class="feature-card glass-card"
              role="button"
              tabindex="0"
              @click="card.action === 'coding' ? onCodeClick() : undefined"
              @keydown.enter="card.action === 'coding' ? onCodeClick() : undefined"
            >
              <div class="feature-card-icon" :style="{ backgroundColor: card.iconBg }">
                {{ card.icon }}
              </div>
              <div class="feature-card-body">
                <div class="feature-card-title">{{ card.title }}</div>
                <div class="feature-card-desc">{{ card.desc }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
```

同时删除 `<FeatureSection ... />` 行以及顶部 `import FeatureSection from '@/components/FeatureSection.vue';`（如果只在这里用）。

如果想保留 FeatureSection.vue 的复用性，**另选**：在 FeatureSection.vue 加 `emit('cardClick', card)` 事件，由 App.vue 监听。但本计划选前者，简单直接。

- [ ] **Step 4: 加 css（保持与原 FeatureSection 一致）**

打开 [offline-app/src/App.vue:62-75](offline-app/src/App.vue#L62-L75) 的 `<style lang="scss" scoped>` 块，在 `.sections { padding: 8px 0; }` 后追加：

```scss
.section-block {
  padding: 8px 16px;
}
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
}
.section-header-icon {
  font-size: 20px;
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text, #111827);
}
.section-subtitle {
  font-size: 12px;
  color: var(--color-text-secondary, #6b7280);
}
.section-cards {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.feature-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 12px;
  cursor: pointer;
  transition: background-color 200ms;
}
.feature-card:hover {
  background: rgba(255, 255, 255, 0.5);
}
.feature-card-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 20px;
  flex-shrink: 0;
}
.feature-card-body {
  flex: 1;
  min-width: 0;
}
.feature-card-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text, #111827);
}
.feature-card-desc {
  font-size: 12px;
  color: var(--color-text-secondary, #6b7280);
  margin-top: 2px;
}
```

- [ ] **Step 5: BottomTabBar 的 code tab 接 onCodeClick**

定位 `BottomTabBar @select="onTabSelect"`（[offline-app/src/App.vue:49](offline-app/src/App.vue#L49)）。改为：

```vue
    <BottomTabBar
      :tabs="bottomTabs"
      @select="(id) => id === 'code' ? onCodeClick() : onTabSelect(id)"
    />
```

`onTabSelect` 函数保留，作为其他 tab 的占位（保留原 `console.log` 行为）：

```ts
function onTabSelect(_id: string) {
  console.log('tab select (offline)');
}
```

（修改原 `function onTabSelect(id: string)` 的实现即可。）

- [ ] **Step 6: 验证 vite 编译**

Run: `npm run build:offline`
Expected: 编译成功。

- [ ] **Step 7: Commit**

按项目 commit 格式：
```
【需求/缺陷描述】: App.vue 接通 coding（卡片 + tab 共用 onCodeClick）
【需求/缺陷单号】: 无
【修改内容】:
- App.vue 加 onCodeClick 处理函数 + isCodeCard 辅助
- FeatureSection 替换为内联渲染：写代码卡片走 onCodeClick，其余走原占位
- BottomTabBar code tab 走 onCodeClick，其余走 onTabSelect 占位
- 加 .section-block / .feature-card 等 scss（保持与原 FeatureSection 视觉一致）
- dev 模式无 IPC 仅 console.log
```

---

## Task 19: 集成验证 — 全流程手动测试

**Files:** 无（仅运行 + 记录）

### Steps

- [ ] **Step 1: 起 dev 环境**

Run: `npm run dev`
Expected: Vite 启动 + Electron 启动 → 主窗口弹出，显示 offline 页。

- [ ] **Step 2: 验证 autostart 路径**

未装 opencode：观察主窗口是否正常弹出（不应被 autostart 失败影响）。看 main.log（路径在 userData 目录下）有 `coding: opencode not installed, skip autostart` 日志。

已装 opencode：先 `npm i -g opencode-ai` 装一个，再起 dev。日志应见 `coding: autostart: detected ... version=...` + `coding: status → ready http://127.0.0.1:4296`。

- [ ] **Step 3: 验证「写代码」卡片点击 → install + spawn + 切 view**

卸载 opencode（如果装了）：`npm uninstall -g opencode-ai`

重启 macapp。点击 offline 页「写代码」卡片。

Expected（无 Node.js 时）：
- 主进程 emit `{state: 'spawn-failed', message: '请先安装 Node.js（含 npm）'}`
- 编码 tab 不切 view
- ElNotification 提示「需要 Node.js」

Expected（有 Node.js 时）：
- ElMessage「正在安装 opencode…」持续
- install 完成（npm install -g opencode-ai 几秒到几分钟）
- ElMessage.closeAll
- 自动切到 codingView，显示 opencode web UI
- main.log 看到 `coding: status → ready http://127.0.0.1:4296`

- [ ] **Step 4: 验证退出回收**

macapp 退出。检查主进程日志：应见 `coding: shutdown: killing opencode child`。

Terminal 跑 `lsof -i :4296`（macOS）或 `netstat -ano | findstr 4296`（Windows）。Expected: 无残留 opencode 进程。

- [ ] **Step 5: 验证 retry 路径**

启动 macapp（autostart=false 的状态）→ opencode 已装但 kill 掉 → 点编码 tab → 应走 installAndStart 路径（已装所以跳过 install，直接 spawn）→ success。

- [ ] **Step 6: 验证端口冲突**

启动两个 opencode 进程（手工开一个 + macapp autostart 一个）。macapp autostart 应自动探测 4297-4300 找空闲端口，日志见 `coding: port fallback to 4297`（如果 4297 输出此日志）。

- [ ] **Step 7: Commit（如果有发现的问题修复）**

如果验证中发现 bug，按 spec §8.5 验收标准逐项修复并提交。每个修复一个 commit。

---

## Task 20: 文档更新

**Files:**
- Modify: `README.md`（如有，加 codingAgent 使用说明）
- Modify: `docs/opencode编程能力集成方案.md`（v1.0 → v1.1 状态标注）

### Steps

- [ ] **Step 1: 给 v1.0 草案加「已被 v1.1 替代」标注**

打开 [docs/opencode编程能力集成方案.md:3-7](docs/opencode编程能力集成方案.md#L3-L7)，把：

```
- 状态：待评审
```

改为：

```
- 状态：v1.0 草案（**已被 v1.1 替代**，见 [docs/superpowers/specs/2026-09-08-opencode-on-demand-install-and-autostart-design.md](superpowers/specs/2026-09-08-opencode-on-demand-install-and-autostart-design.md)）
```

并加一行指向 v1.1 的链接。

- [ ] **Step 2: 检查 README.md 是否需要更新**

Run: `grep -n "codingAgent\|opencode" README.md` （若 grep 不可用则 Read）

如果 README 没有相关章节，跳过；如果有相关章节，加一段指向 v1.1 spec。

- [ ] **Step 3: 提交**

按项目 commit 格式：
```
【需求/缺陷描述】: 文档更新 — v1.0 草案标替代，README 指向 v1.1
【需求/缺陷单号】: 无
【修改内容】:
- docs/opencode编程能力集成方案.md 加「已被 v1.1 替代」标注 + 链接
- README.md 如有相关章节加链接
```

---

## 自审 Checklist（写入前请逐项打勾）

- [x] 每个任务有明确 Files 列表
- [x] 每个步骤有具体代码（非 TBD / 占位）
- [x] Type 一致：CodingStatus / CodingOpenResult / CodingAgentConfig 在 Task 1/2 定义后所有任务复用同一形状
- [x] handleOpen 的 view 切换归属主进程（spec §3.1 已修订，前端不调 showOnly）
- [x] 状态机覆盖 spec §3.1 全部 7 种状态
- [x] 错误矩阵覆盖 spec §5.4 全部失败点
- [x] 端口探测、cwd fallback、安全基线、日志位置按 spec §7 实现
- [x] 不动安装器（spec §1.3）
- [x] 测试文件标注「行为文档，未跑」（spec §7.6）
- [x] 每步 commit 用项目规定格式
- [x] M2 范围（不含 M3 增强项：自更新、dialog 选择目录等）

---

## 执行 Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-08-opencode-on-demand-install-and-autostart.md`. 两种执行方式：

1. **Subagent-Driven (recommended)** - 每个 Task 派一个 fresh subagent，task 间我做两阶段 review，快速迭代
2. **Inline Execution** - 当前 session 内串行执行所有 Task，里程碑处停下来 review

你选哪个？
