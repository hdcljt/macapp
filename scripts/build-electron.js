/**
 * 编译 Electron 主进程和 preload 脚本
 * 复制 splash.html / error.html 等静态资源
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

  // 复制静态资源（splash / error 页面）到 dist-electron
  const staticFiles = ['splash.html', 'error.html'];
  for (const file of staticFiles) {
    const src = path.join(root, 'electron', file);
    const dest = path.join(outdir, file);
    fs.copyFileSync(src, dest);
    console.log(`📄 复制 ${file} → dist-electron/`);
  }

  console.log('✅ Electron 编译完成');
}

buildElectron().catch((err) => {
  console.error(err);
  process.exit(1);
});
