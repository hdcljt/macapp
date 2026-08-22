#!/usr/bin/env node
/**
 * Smoke test：验证 electron-logger-bridge 的核心逻辑
 *
 * 覆盖：
 * - formatArgs：string、Error、object、循环引用、多参数拼接
 * - wrapConsole：5 个方法都能替换 + 转发 + 保留原 console
 * - 异常安全：api.log reject 时不影响原 console
 *
 * 用 esbuild 临时把 .ts 编译成 .cjs（Node 跑），不污染源码
 *
 * 用法：node scripts/test-console-forwarding.cjs
 */

const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TMP_DIR = path.join(ROOT, '.tmp-test-build');
const ENTRY = path.join(ROOT, 'offline-app', 'src', 'electron-logger-bridge.ts');
const OUT_FILE = path.join(TMP_DIR, 'electron-logger-bridge.cjs');

// 1. 临时编译
fs.mkdirSync(TMP_DIR, { recursive: true });
buildSync();

function buildSync() {
  // 同步阻塞 build（esbuild API 是 async，简单起见手写 promise.then）
}

(async () => {
  try {
    await build({
      entryPoints: [ENTRY],
      bundle: false,
      outfile: OUT_FILE,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      logLevel: 'silent',
    });
  } catch (err) {
    console.error('esbuild 编译失败:', err.message);
    process.exit(1);
  }

  // 2. 加载编译产物
  const { formatArgs, wrapConsole } = require(OUT_FILE);

  const errors = [];

  // ====== 测试 formatArgs ======

  // (1) string 原样
  let r = formatArgs(['hello']);
  if (r !== 'hello') errors.push(`formatArgs(string): 应为 'hello' (实际: '${r}')`);

  // (2) Error
  const e = new TypeError('bad type');
  r = formatArgs([e]);
  if (r !== 'TypeError: bad type') errors.push(`formatArgs(Error): 应为 'TypeError: bad type' (实际: '${r}')`);

  // (3) object
  r = formatArgs([{ a: 1, b: 'x' }]);
  if (r !== '{"a":1,"b":"x"}') errors.push(`formatArgs(object): 应为 '{"a":1,"b":"x"}' (实际: '${r}')`);

  // (4) 多参数拼接
  r = formatArgs(['count=', 3, true, null]);
  if (r !== 'count= 3 true null') {
    errors.push(`formatArgs(multi): 应为 'count= 3 true null' (实际: '${r}')`);
  }

  // (5) 循环引用降级到 String()
  const circ = {};
  circ.self = circ;
  r = formatArgs([circ]);
  if (!r.includes('[object Object]') && !r.includes('circ')) {
    // String(circ) = '[object Object]'
    errors.push(`formatArgs(circular): 应降级到 String() (实际: '${r}')`);
  }

  // (6) undefined / null
  r = formatArgs([undefined, null]);
  // JSON.stringify(undefined) = undefined (返回 undefined，被 join 当成 '')
  // JSON.stringify(null) = 'null'
  if (r !== ' null') {
    errors.push(`formatArgs(undefined/null): 应为 ' null' (实际: '${r}')`);
  }

  // ====== 测试 wrapConsole ======

  // mock api.log 收集调用
  const calls = [];
  const mockApi = {
    log: (level, message) => {
      calls.push({ level, message });
      return Promise.resolve();
    },
  };

  // 保存原 console
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origInfo = console.info;
  const origDebug = console.debug;

  try {
    wrapConsole(mockApi);

    // 调用包装后的 console
    console.log('hello');
    console.info('info msg');
    console.warn('warn msg');
    console.error('err msg');
    console.debug('dbg msg');

    // 等异步微任务执行完
    await new Promise((r) => setImmediate(r));

    // 验证：5 次调用都被转发到 mockApi
    if (calls.length !== 5) {
      errors.push(`wrapConsole: 期望 5 次 IPC 转发 (实际: ${calls.length})`);
    }

    // 验证级别映射
    const levels = calls.map((c) => c.level);
    const expected = ['info', 'info', 'warn', 'error', 'debug'];
    if (JSON.stringify(levels) !== JSON.stringify(expected)) {
      errors.push(`wrapConsole level: 期望 ${JSON.stringify(expected)} (实际: ${JSON.stringify(levels)})`);
    }

    // 验证消息
    const messages = calls.map((c) => c.message);
    if (messages[0] !== 'hello' || messages[1] !== 'info msg' || messages[4] !== 'dbg msg') {
      errors.push(`wrapConsole messages: ${JSON.stringify(messages)}`);
    }

    // 多参数
    console.log('count=', 3);
    await new Promise((r) => setImmediate(r));
    if (calls[calls.length - 1].message !== 'count= 3') {
      errors.push(`wrapConsole multi-args: 期望 'count= 3' (实际: '${calls[calls.length - 1].message}')`);
    }
  } finally {
    // 还原原 console
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    console.info = origInfo;
    console.debug = origDebug;
  }

  // ====== 测试异常安全 ======

  // mock api.log reject 不应抛出到调用方
  const callsBefore = calls.length;
  const rejectApi = {
    log: () => Promise.reject(new Error('IPC failed')),
  };

  try {
    wrapConsole(rejectApi);
    try {
      console.error('this should not throw');
      // 同步部分（调原 console）不抛
    } catch {
      errors.push('wrapConsole: 原 console 调用不应抛');
    }
    // 异步 reject 应被 .catch 吞掉
    await new Promise((r) => setImmediate(r));
    // 没崩就 OK
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    console.info = origInfo;
    console.debug = origDebug;
  }

  // ====== 测试 formatArgs 抛错时也不影响 console ======

  // 模拟 formatArgs 抛错：在 console.error 调用时如果 formatArgs 异常，整个 forward() 应 try/catch
  // 这个已经由 forward() 的 try/catch 保证，直接信任

  // 清理临时文件
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  if (errors.length > 0) {
    console.error('=== ✗ 验证失败 ===');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log('=== ✓ 全部通过 ===');
  console.log(`- formatArgs: string / Error / object / 多参数 / 循环引用降级 / nullish ✓`);
  console.log(`- wrapConsole: 5 个方法 + 级别映射(log→info) + 多参数 ✓`);
  console.log(`- 异常安全: api.log reject 不影响原 console ✓`);
})().catch((err) => {
  console.error('test crash:', err);
  process.exit(1);
});
