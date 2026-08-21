/**
 * 编译 Electron 主进程和 preload 脚本
 * 复制 splash.html / error.html 等静态资源
 */
const { build } = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');

// CJS 模式下 __dirname 是内置的；ESM 模式下需要用 import.meta.url

const root = path.resolve(__dirname, '..');

async function buildElectron() {
  const outdir = path.join(root, 'dist-electron');
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir, { recursive: true });
  }

  // esbuild 配置说明：
  // - mainFields: ['module', 'main'] 让 esbuild 优先选 ESM 源（jsonc-parser 的
  //   lib/esm/main.js 使用静态 import，可被 esbuild 正确内联）。默认 mainFields
  //   会选 UMD（lib/umd/main.js），但 UMD 闭包内的 require('./impl/format')
  //   是动态调用，esbuild 无法静态内联，导致运行时 dist-electron/impl/format.js
  //   不存在而抛 Cannot find module。
  const buildOptions = {
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    mainFields: ['module', 'main'],
    // electron-updater 由 esbuild inline bundle（依赖 electron 自身 API，
    // 不能 external 化）。预期 main.js 体积 +200KB。
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  };

  // 编译 main.ts
  await build({
    ...buildOptions,
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(outdir, 'main.js'),
  });

  // 编译 preload.ts
  await build({
    ...buildOptions,
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(outdir, 'preload.js'),
  });

  // electron-updater 会被 esbuild inline bundle 进 main.js（无需额外配置）
  // 但 updater.html / updater.js 是运行时静态资源，必须手动复制到 dist-electron
  const staticFiles = ['splash.html', 'retry.html', 'error.html', 'error.js', 'updater.html', 'updater.css', 'updater.js'];
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
