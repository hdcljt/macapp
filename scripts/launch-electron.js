/**
 * 启动 Electron
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

// 关键：彻底移除 ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_RUN_AS_NODE;

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
