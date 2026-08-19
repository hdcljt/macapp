/**
 * Windows 打包脚本
 * 解决 electron-builder 26 在 Windows 上的重命名 EPERM 问题
 * 策略：分阶段打包，最后手动压缩成 ZIP
 */
const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const VERSION = require(path.join(ROOT, 'package.json')).version;

function log(msg) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(msg);
  console.log('='.repeat(50));
}

function run(cmd, options = {}) {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', ...options });
    return true;
  } catch (err) {
    console.error('⚠️  命令失败:', err.message);
    return false;
  }
}

function runStrict(cmd, options = {}) {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', ...options });
  } catch (err) {
    console.error('❌ 命令失败:', err.message);
    throw err;
  }
}

function copyDirRobust(src, dest) {
  // PowerShell 复制（更稳健）
  if (fs.existsSync(dest)) {
    run(`powershell -Command "Remove-Item '${dest}' -Recurse -Force"`);
  }
  run(`powershell -Command "Copy-Item '${src}' '${dest}' -Recurse"`);
  console.log(`✅ 已复制: ${src} -> ${dest}`);
}

function main() {
  log('🧹 清理旧产物');
  if (fs.existsSync(RELEASE_DIR)) {
    run(`powershell -Command "Remove-Item '${RELEASE_DIR}' -Recurse -Force"`);
  }
  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  log('🔨 步骤 1/4: 编译 Electron 主进程');
  run('node scripts/build-electron.js', { cwd: ROOT });

  log('🎨 步骤 2/4: 编译前端代码');
  run('npm run build:renderer', { cwd: ROOT });

  log('📦 步骤 3/4: electron-builder 解压 Electron 二进制');
  // 预期会失败（Windows + Defender 锁定），步骤 4 会修复
  run('npx electron-builder --win --dir', {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    },
  });

  log('🔧 步骤 4/4: 修复 win-unpacked 目录 + 打包 ZIP');

  const versionDir = path.join(RELEASE_DIR, VERSION);
  const tmpDir = path.join(versionDir, 'win-unpacked.tmp');
  const finalDir = path.join(versionDir, 'win-unpacked');

  if (!fs.existsSync(tmpDir)) {
    console.error('❌ 找不到 win-unpacked.tmp，打包失败');
    process.exit(1);
  }

  if (fs.existsSync(finalDir)) {
    run(`powershell -Command "Remove-Item '${finalDir}' -Recurse -Force"`);
  }

  // 用 Copy 替代 Rename（绕过 Windows Defender 锁）
  copyDirRobust(tmpDir, finalDir);
  run(`powershell -Command "Remove-Item '${tmpDir}' -Recurse -Force"`);

  // 打包成 ZIP
  const zipPath = path.join(RELEASE_DIR, `算粒AI助手-${VERSION}-x64.zip`);
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
  run(`powershell -Command "Compress-Archive -Path '${finalDir}' -DestinationPath '${zipPath}' -Force"`);

  // 显示结果
  const zipStat = fs.statSync(zipPath);
  const sizeMB = (zipStat.size / 1024 / 1024).toFixed(2);
  console.log(`\n🎉 打包完成！`);
  console.log(`📦 文件: ${zipPath}`);
  console.log(`📊 大小: ${sizeMB} MB`);
  console.log(`\n💡 运行方式：`);
  console.log(`   1. 解压 ZIP 到任意目录`);
  console.log(`   2. 双击 算粒AI助手.exe 运行`);
  console.log(`   3. 或将目录中的内容复制到 C:\\Program Files\\`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
