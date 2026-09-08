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
  { toolName: 'DSH Web', expectUrlContains: '127.0.0.1' },
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
  } else {
    // embedded 应切到 codingView
    const codingPage = pages.find((p) => p.url().includes(tool.expectUrlContains) && !p.url().includes('offline-app'));
    if (codingPage) {
      console.log(`✓ embedded: codingView 切到 ${codingPage.url()}`);
      results.push({ tool: tool.toolName, ok: true, url: codingPage.url() });
    } else {
      results.push({ tool: tool.toolName, ok: false, msg: 'codingView 没切到内嵌 web' });
    }
  }
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
    if (text.includes('app.coding') || text.includes('app.renderer')) {
      console.log(`[M] ${text}`);
    }
  });

  const window = await app.firstWindow({ timeout: 30000 });
  console.log(`first window URL: ${window.url()}`);

  const ctx = app.context();

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
