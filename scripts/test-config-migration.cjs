#!/usr/bin/env node
/**
 * Smoke test：验证 config.ts 的向后兼容迁移逻辑
 *
 * 模拟场景：v0.5.6 → v0.6.0 升级
 * - userConfig: 旧版本（10 个字段，缺 useOfflineFallback）
 * - bundledConfig: 新版本（11 个字段）
 * - 期望：迁移后 userConfig 保留原注释 + 原字段值 + 新增 useOfflineFallback
 *
 * 用法：node scripts/test-config-migration.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const { parse, modify, applyEdits } = require('jsonc-parser');

const ROOT = path.join(__dirname, '..');

// 1. 读取真实的 bundled config（v0.6.0，11 字段）
const bundledPath = path.join(ROOT, 'config.jsonc');
const bundledText = fs.readFileSync(bundledPath, 'utf-8');
const bundledData = parse(bundledText, [], { allowTrailingComma: true });

console.log(`bundled 字段数: ${Object.keys(bundledData).length}`);
console.log(`bundled 字段: ${Object.keys(bundledData).join(', ')}`);
console.log('');

// 2. 模拟用户老 config（v0.5.6，10 字段，缺 useOfflineFallback）
const userText = `{
  // 目标 URL：Electron 启动后 contentView 会加载此地址
  // will-navigate 拦截从此字段推导 origin；仅接受 http:// 与 https://
  // "targetUrl": "http://localhost:5195/agent-user/assistant",
  "targetUrl": "https://cloudrender-sche-test.migu.cn:10600/agent-user/assistant",

  // 目标 URL 加载失败时的重试次数。设为 0 表示不重试，直接进入错误页
  "maxRetries": 3,

  // 每次重试间隔（毫秒）。覆盖 ERR_CONNECTION_REFUSED 等所有错误
  "retryDelayMs": 5000,

  // BrowserWindow 初始尺寸
  "width": 1180,
  "height": 820,

  // BrowserWindow 最小尺寸
  "minWidth": 900,
  "minHeight": 700,

  // 是否启用在线更新检测
  "autoUpdate": true,

  // 更新通道
  "updateChannel": "stable",

  // dismiss 后静默期
  "dismissCooldownHours": 24
}`;

console.log('=== 用户原 config (v0.5.6 模拟) ===');
console.log(userText);
console.log('');

// 3. 解析并找出缺失字段
const userData = parse(userText, [], { allowTrailingComma: true });
const missing = Object.keys(bundledData).filter((k) => !(k in userData));
console.log(`缺失字段: ${missing.join(', ') || '(无)'}`);
console.log('');

// 4. 用 modify() 增量插入新字段（modify 返回 ApplyEdits[]，需 applyEdits 应用）
let mergedText = userText;
const failed = [];
for (const field of missing) {
  const edits = modify(mergedText, [field], bundledData[field], {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  if (edits === undefined) {
    failed.push(field);
  } else {
    const applied = applyEdits(mergedText, edits);
    if (applied === undefined) {
      failed.push(field);
    } else {
      mergedText = applied;
    }
  }
}

if (failed.length > 0) {
  console.error(`✗ modify() 失败字段: ${failed.join(', ')}`);
  process.exit(1);
}

console.log('=== 迁移后 config ===');
console.log(mergedText);
console.log('');

// 5. 验证：解析迁移后的文本，校验所有字段
const mergedData = parse(mergedText, [], { allowTrailingComma: true });
const errors = [];

// 校验字段值
if (mergedData.targetUrl !== userData.targetUrl) {
  errors.push(`targetUrl 被覆盖: ${mergedData.targetUrl} (期望 ${userData.targetUrl})`);
}
if (mergedData.useOfflineFallback !== true) {
  errors.push(`useOfflineFallback 应为 true (实际: ${mergedData.useOfflineFallback})`);
}
if (Object.keys(mergedData).length !== 11) {
  errors.push(`字段总数应为 11 (实际: ${Object.keys(mergedData).length})`);
}

// 校验注释保留
if (!mergedText.includes('// 目标 URL：Electron 启动后 contentView 会加载此地址')) {
  errors.push('用户原注释丢失: 目标 URL 注释');
}
if (!mergedText.includes('// 是否启用在线更新检测')) {
  errors.push('用户原注释丢失: autoUpdate 注释');
}

// 校验缩进风格
const lines = mergedText.split('\n');
const has2SpaceIndent = lines.some((l) => /^ {2}"\w+":/.test(l));
if (!has2SpaceIndent) {
  errors.push('未使用 2 空格缩进');
}

if (errors.length > 0) {
  console.error('=== ✗ 验证失败 ===');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log('=== ✓ 全部通过 ===');
console.log(`- 字段总数: ${Object.keys(mergedData).length} (期望 11)`);
console.log(`- targetUrl 保留: ${mergedData.targetUrl === userData.targetUrl ? '✓' : '✗'}`);
console.log(`- useOfflineFallback 补齐: ${mergedData.useOfflineFallback === true ? '✓' : '✗'}`);
console.log(`- 用户注释保留: ✓`);
console.log(`- 2 空格缩进: ✓`);
