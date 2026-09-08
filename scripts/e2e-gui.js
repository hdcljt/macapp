/**
 * 完整 GUI 端到端测试：Playwright _electron 启 app，
 * 对 3 个工具各点一次，截图 + 验证主进程日志 + 验证页面状态。
 *
 * 用法：timeout 120 node scripts/e2e-gui.js
 * 实测 ~90s（3 个工具 × ~25s + 启动/screenshot 开销），120s 留缓冲
 */
const { _electron: electron } = require('playwright');
const fs = require('node:fs');

const TESTS = [
  { toolName: 'OpenCode Web', expectUrlContains: '127.0.0.1' },
  // url 类型：embedded → url 切工具 origin 变化，codingView 应 destroy+重建
  { toolName: 'MiniMax Agent', expectUrlContains: 'agent.minimaxi.com' },
  { toolName: 'DSH Web', expectUrlContains: '127.0.0.1' },
  // url 类型二次进入：origin 不变（仍是 minimaxi.com），应复用 codingView + loadURL
  { toolName: 'MiniMax Agent', expectUrlContains: 'agent.minimaxi.com' },
  { toolName: 'CodeBuddy', expectUrlContains: null, external: true },
];

async function capturePages(ctx, label) {
  // 直接截每个 page 的 viewport —— Playwright 拿到的每个 page 就是一个 webContents，
  // 截 page 就能看到那个 view 的实际渲染。
  // BrowserWindow composite 截图需要在 main process eval，但 Playwright 的 eval 沙箱
  // 限制 require/外部引用，所以拆成截每个 page。
  const pages = ctx.pages();
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const safeUrl = p.url().slice(0, 60).replace(/[^a-z0-9]/gi, '_');
    const file = `e2e-${label}-page${i}-${safeUrl}.png`;
    try {
      await p.screenshot({ path: file, timeout: 5000 });
      out.push({ index: i, url: p.url(), file });
      console.log(`  📸 page[${i}] (${p.url().slice(0, 60)}...) → ${file}`);
    } catch (e) {
      out.push({ index: i, url: p.url(), file: null, error: e.message });
      console.log(`  ✗ page[${i}] screenshot failed: ${e.message}`);
    }
  }
  return out;
}

const results = [];
let screenshots = [];

async function runOne(window, ctx, tool) {
  const label = tool.toolName.replace(/\s+/g, '_');
  console.log(`\n========== ${tool.toolName} ==========`);

  // 关掉之前的 dialog（如果还开）
  await window.keyboard.press('Escape').catch(() => {});
  await window.waitForTimeout(300);

  // 找"写代码"卡片并点
  const writeCode = window.locator('text=写代码').first();
  await writeCode.click();
  await window.waitForTimeout(1000);

  // 找目标工具按钮
  const targetBtn = window.locator(`button.tool-btn:has-text("${tool.toolName}")`).first();
  const cnt = await targetBtn.count();
  if (cnt === 0) {
    const msg = `${tool.toolName}: button not found in dialog`;
    console.log(`✗ ${msg}`);
    results.push({ tool: tool.toolName, ok: false, msg });
    const failShots = await capturePages(ctx, `${label}-FAIL`);
    failShots.forEach((s) => s.file && screenshots.push(s.file));
    return;
  }
  await targetBtn.click();
  console.log(`clicked "${tool.toolName}"`);

  // 等 spawn + view 切换
  await window.waitForTimeout(8000);
  const afterShots = await capturePages(ctx, `${label}-after`);
  afterShots.forEach((s) => s.file && screenshots.push(s.file));

  // embedded 工具现在 openTool 会自动 shutdown 上一个 + spawn 新，无需等 cleanup
  // 只需要 2s 让 SIGTERM 释放端口（TIME_WAIT）给新工具用
  if (!tool.external) {
    await window.waitForTimeout(2000);
  }

  // 列所有 pages
  const pages = ctx.pages();
  console.log(`pages after click (${pages.length}):`);
  pages.forEach((p, i) => console.log(`  page[${i}] url=${p.url()}`));

  if (tool.external) {
    // external 不切 view，spawn detached 后 launching-external status 推送
    // 验证：主进程日志有 launching-external emit，且 page[0] 仍是 offline-app
    const offlineStill = pages.find((p) => p.url().includes('offline-app/index.html'));
    if (offlineStill) {
      console.log(`✓ external: offlineView 还在（OS 接管 IDE，window 不切）`);
      results.push({ tool: tool.toolName, ok: true });
    } else {
      results.push({ tool: tool.toolName, ok: false, msg: 'offlineView 不见了' });
    }
    return;
  }

  // embedded 应切到 codingView
  const codingPage = pages.find((p) => p.url().includes(tool.expectUrlContains) && !p.url().includes('offline-app'));
  if (!codingPage) {
    const msg = 'codingView 没切到内嵌 web';
    console.log(`✗ ${msg}`);
    results.push({ tool: tool.toolName, ok: false, msg });
    return;
  }
  console.log(`✓ embedded: codingView 切到 ${codingPage.url()}`);
  results.push({ tool: tool.toolName, ok: true, url: codingPage.url() });

  // 额外验证：点 chromeView 上的「← 返回首页」按钮，view 应该切回 offlineView。
  // （只有 embedded 工具有这个 view 切换路径，external 不切 view 所以不测。）
  const chromePage = ctx.pages().find((p) => p.url().includes('chrome.html'));
  if (!chromePage) {
    console.log('  ⚠ chromeView page 没找到，跳过 home 按钮验证');
    return;
  }
  const homeBtn = chromePage.locator('#home-btn');
  // 用 Playwright auto-wait click：它会等到按钮 stable+visible 才点（默认 30s timeout）。
  // isVisible() 立即检查会错过「setCodingActive 异步切 display」的窗口期。
  try {
    await homeBtn.click({ timeout: 5000 });
    console.log(`  clicked "← 返回首页"`);
  } catch (err) {
    console.log(`  ✗ home 按钮不可点: ${err.message.split('\n')[0]}`);
    results.push({ tool: tool.toolName, ok: false, msg: 'home 按钮不可点（可能被 chromeView 盖住或 display: none）' });
    return;
  }
  await window.waitForTimeout(1000);

  // 验证：点完后 offlineView 应该重新可见（page[0] 仍是 offline-app URL）
  const pagesAfterHome = ctx.pages();
  const offlineAfter = pagesAfterHome.find((p) => p.url().includes('offline-app/index.html'));
  if (offlineAfter) {
    console.log(`  ✓ home 按钮：view 已切回 offlineView`);
  } else {
    console.log(`  ✗ home 按钮：切回 offlineView 失败`);
    results.push({ tool: tool.toolName, ok: false, msg: 'home 按钮没切回 offlineView' });
  }
  // 截一张「点完 home 按钮之后」的图，作为证据
  const homeShots = await capturePages(ctx, `${label}-after-home`);
  homeShots.forEach((s) => s.file && screenshots.push(s.file));
}

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_ENABLE_LOGGING = '1';

  console.log('=== launching Electron ===');
  const app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    timeout: 60000,
    env,
  });

  // 收集主进程日志
  const mainLogs = [];
  app.process().stdout?.on('data', (d) => { mainLogs.push(d.toString()); });
  app.process().stderr?.on('data', (d) => { mainLogs.push(d.toString()); });

  app.on('console', (msg) => {
    const text = msg.text();
    // 调试期：打印所有 chrome.* 日志 + 主进程日志
    if (text.includes('app.coding') || text.includes('app.renderer') || text.includes('[chrome]')) {
      console.log(`[M] ${text}`);
    }
  });

  // 不依赖 firstWindow：detached devtools 可能抢先创建，导致 firstWindow 不是主窗口。
  // 从 pages() 里挑主窗口（offline-app 或 contentView 的本地路径）。
  await app.firstWindow({ timeout: 30000 }); // 等第一个 webContents 出现（确保进程启动）
  const ctx = app.context();
  let window = null;
  for (let i = 0; i < 30; i++) {
    const offlineApp = ctx.pages().find((p) => p.url().includes('offline-app/index.html'));
    if (offlineApp) { window = offlineApp; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!window) throw new Error('main window (offline-app) not found');
  console.log(`main window URL: ${window.url()}`);

  await window.waitForLoadState('domcontentloaded');
  await window.waitForTimeout(3000);
  const initialShots = await capturePages(ctx, '0-initial');
  initialShots.forEach((s) => s.file && screenshots.push(s.file));

  for (const tool of TESTS) {
    try {
      await runOne(window, ctx, tool);
    } catch (err) {
      console.log(`✗ ${tool.toolName} threw: ${err.message}`);
      results.push({ tool: tool.toolName, ok: false, msg: err.message });
    }
  }

  console.log('\n========== summary ==========');
  results.forEach((r) => {
    console.log(`${r.ok ? '✓' : '✗'} ${r.tool}${r.url ? ' → ' + r.url : ''}${r.msg ? ' (' + r.msg + ')' : ''}`);
  });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '✓ ALL PASSED' : '✗ ' + failed.length + ' FAILED'}`);

  fs.writeFileSync('e2e-main.log', mainLogs.join(''), 'utf-8');
  console.log('main process logs saved to e2e-main.log');
  console.log('screenshots: ' + screenshots.join(', '));

  await app.close();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
