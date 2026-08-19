/**
 * 编译 Electron 主进程和 preload 脚本
 * 使用 esbuild 直接编译，不需要 vite-plugin-electron
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function buildElectron() {
  const outdir = path.join(root, 'dist-electron');
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir, { recursive: true });
  }

  // 编译 main.ts
  await build({
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(outdir, 'main.js'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });

  // 编译 preload.ts
  await build({
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(outdir, 'preload.js'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });

  console.log('✅ Electron 编译完成');
}

buildElectron().catch((err) => {
  console.error(err);
  process.exit(1);
});
