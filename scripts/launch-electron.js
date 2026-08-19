/**
 * 启动 Electron，确保 ELECTRON_RUN_AS_NODE 被正确取消
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

// 关键：彻底移除 ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_RUN_AS_NODE;

// 设置 dev 模式的 renderer URL
process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';

const electronPath = require('electron');
const cwd = path.resolve(__dirname, '..');

console.log('🚀 启动 Electron:', electronPath);
console.log('📍 工作目录:', cwd);

const child = spawn(electronPath, ['.'], {
  cwd,
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => {
  console.log(`Electron exited with code ${code}`);
  process.exit(code);
});
