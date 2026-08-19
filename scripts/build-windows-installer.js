/**
 * Windows NSIS 安装程序打包脚本
 *
 * 解决 electron-builder 26 在 Windows 上的两个 EPERM 问题：
 *   1. 解压 Electron 二进制到 win-unpacked 时失败
 *   2. 重命名 installer .tmp -> .exe 时失败
 *
 * 策略：
 *   - 预先手动下载 + 用 PowerShell 解压 Electron 二进制
 *   - 配置 electronDist 指向预解压目录，让 builder 跳过解压
 *   - 跑 builder 生成 NSIS installer（如果最后 rename 失败，用 PowerShell 修复）
 */
const { execSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const CACHE_DIR = path.join(ROOT, '.electron-cache');
const ELECTRON_DIST = path.join(CACHE_DIR, 'electron');
const PKG = require(path.join(ROOT, 'package.json'));
const VERSION = PKG.version;
const ELECTRON_VERSION = PKG.devDependencies.electron.replace(/^\^/, '');

function log(msg) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(msg);
  console.log('='.repeat(60));
}

function run(cmd, options = {}) {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', ...options });
    return true;
  } catch (err) {
    console.error(`⚠️  命令退出码非 0（可接受）: ${err.message.split('\n')[0]}`);
    return false;
  }
}

function psExec(script) {
  return run(`powershell -Command "${script}"`);
}

function psCopy(src, dest) {
  if (fs.existsSync(dest)) {
    psExec(`Remove-Item '${dest}' -Recurse -Force`);
  }
  psExec(`Copy-Item '${src}' '${dest}' -Recurse -Force`);
  console.log(`✅ 已复制: ${path.basename(src)} -> ${path.basename(dest)}`);
}

/**
 * 下载文件
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, (res) => {
      // 处理 302/301 重定向
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close();
        get(res.headers.location);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
    get(url);
  });
}

/**
 * 准备 Electron 二进制（手动下载并用 PowerShell 解压，绕过 Node EPERM）
 */
async function prepareElectron() {
  log('⚡ 步骤 1/5: 准备 Electron 二进制');

  // 检查 electron.exe 是否已经在缓存里
  const electronExe = path.join(ELECTRON_DIST, 'electron.exe');
  if (fs.existsSync(electronExe)) {
    console.log(`✅ Electron 二进制已缓存: ${ELECTRON_DIST}`);
    return;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // 下载
  const zipName = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
  const zipPath = path.join(CACHE_DIR, zipName);
  const mirrorUrl = `https://npmmirror.com/mirrors/electron/v${ELECTRON_VERSION}/${zipName}`;

  if (!fs.existsSync(zipPath)) {
    console.log(`⬇️  下载: ${mirrorUrl}`);
    await downloadFile(mirrorUrl, zipPath);
    console.log(`✅ 已下载: ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB`);
  } else {
    console.log(`✅ ZIP 已缓存: ${zipPath}`);
  }

  // 用 PowerShell 解压（不会触发 Node 的 rename EPERM）
  if (fs.existsSync(ELECTRON_DIST)) {
    psExec(`Remove-Item '${ELECTRON_DIST}' -Recurse -Force`);
  }
  fs.mkdirSync(ELECTRON_DIST, { recursive: true });

  psExec(`Expand-Archive -Path '${zipPath}' -DestinationPath '${ELECTRON_DIST}' -Force`);
  console.log(`✅ 已解压到: ${ELECTRON_DIST}`);

  if (!fs.existsSync(electronExe)) {
    throw new Error(`解压后找不到 ${electronExe}`);
  }
}

/**
 * 编译主进程 + 渲染层
 */
function compileApp() {
  log('🔨 步骤 2/5: 编译 Electron 主进程 + 渲染层');
  run('node scripts/build-electron.js', { cwd: ROOT });
  run('npm run build:renderer', { cwd: ROOT });
}

/**
 * 跑 electron-builder 生成 NSIS installer
 */
function runBuilder() {
  log('📦 步骤 3/5: electron-builder 生成 NSIS installer');
  // 注意：electronDist 已配置，builder 会跳过自动解压
  run('npx electron-builder --win --x64', {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
      ELECTRON_RUN_AS_NODE: '0',
    },
  });
}

/**
 * 修复 EPERM 锁定产物
 */
function fixEpfrem() {
  log('🔧 步骤 4/5: 修复 EPERM 锁定的中间产物');

  const versionDir = path.join(RELEASE_DIR, VERSION);
  if (!fs.existsSync(versionDir)) {
    throw new Error(`找不到产物目录: ${versionDir}`);
  }

  // 1) 修复 win-unpacked.tmp
  const tmpUnpacked = path.join(versionDir, 'win-unpacked.tmp');
  const finalUnpacked = path.join(versionDir, 'win-unpacked');
  if (fs.existsSync(tmpUnpacked)) {
    if (fs.existsSync(finalUnpacked)) {
      psExec(`Remove-Item '${finalUnpacked}' -Recurse -Force`);
    }
    psCopy(tmpUnpacked, finalUnpacked);
    psExec(`Remove-Item '${tmpUnpacked}' -Recurse -Force`);
  }

  // 2) 修复 installer exe.tmp
  const entries = fs.readdirSync(versionDir);
  for (const name of entries) {
    if (name.endsWith('.exe.tmp')) {
      const tmp = path.join(versionDir, name);
      const final = path.join(versionDir, name.replace(/\.tmp$/, ''));
      psCopy(tmp, final);
      psExec(`Remove-Item '${tmp}' -Recurse -Force`);
    }
  }
}

/**
 * 同时生成便携 ZIP
 */
function buildPortableZip() {
  log('📦 附加：生成便携 ZIP 包');

  const versionDir = path.join(RELEASE_DIR, VERSION);
  const unpackedDir = path.join(versionDir, 'win-unpacked');

  if (!fs.existsSync(unpackedDir)) {
    console.log('⚠️  win-unpacked 不存在，跳过 ZIP 生成');
    return;
  }

  const zipPath = path.join(RELEASE_DIR, `算粒AI助手-${VERSION}-x64.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  psExec(`Compress-Archive -Path '${unpackedDir}' -DestinationPath '${zipPath}' -Force`);
  console.log(`✅ 便携 ZIP: ${zipPath}`);
}

/**
 * 显示结果
 */
function showResult() {
  log('🎉 步骤 5/5: 打包完成');

  const versionDir = path.join(RELEASE_DIR, VERSION);
  const items = fs.readdirSync(versionDir);

  console.log('\n📂 产物清单：');
  for (const name of items) {
    const full = path.join(versionDir, name);
    if (fs.statSync(full).isDirectory()) {
      console.log(`  📁 ${name}/`);
    } else {
      const size = (fs.statSync(full).size / 1024 / 1024).toFixed(2);
      console.log(`  📄 ${name}  (${size} MB)`);
    }
  }

  const zipPath = path.join(RELEASE_DIR, `算粒AI助手-${VERSION}-x64.zip`);
  if (fs.existsSync(zipPath)) {
    const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
    console.log(`\n📦 便携 ZIP: ${zipPath}  (${size} MB)`);
  }

  const installer = items.find(f => f.endsWith('-Setup.exe'));
  if (installer) {
    const full = path.join(versionDir, installer);
    const size = (fs.statSync(full).size / 1024 / 1024).toFixed(2);
    console.log(`💿 安装程序: ${full}  (${size} MB)`);
    console.log(`\n✨ 双击安装即可，会自动创建桌面快捷方式和开始菜单项`);
    console.log(`   安装路径默认: C:\\Users\\<用户>\\AppData\\Local\\Programs\\算粒AI助手\\`);
  } else {
    console.log('\n⚠️  未找到 NSIS installer，请查看上方日志');
  }
}

/**
 * 临时给 package.json 设置 electronDist（指向预解压目录）
 * 这样 builder 会跳过自动解压。跑完后还原。
 * 注意：macOS job 不需要 electronDist（默认下载即可），所以这里只在 Windows 打包时临时注入。
 */
function withElectronDist(fn) {
  const pkgPath = path.join(ROOT, 'package.json');
  const original = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(original);
  pkg.build = pkg.build || {};
  pkg.build.electronDist = '.electron-cache/electron';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('🔧 临时设置 package.json: electronDist = .electron-cache/electron');
  try {
    return fn();
  } finally {
    fs.writeFileSync(pkgPath, original);
    console.log('🔧 已还原 package.json');
  }
}

async function main() {
  log('🧹 清理旧产物');
  if (fs.existsSync(RELEASE_DIR)) {
    psExec(`Remove-Item '${RELEASE_DIR}' -Recurse -Force`);
  }
  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  await prepareElectron();
  compileApp();
  withElectronDist(() => {
    runBuilder();
    fixEpfrem();
  });
  buildPortableZip();
  showResult();
}

main().catch((err) => {
  console.error('\n❌ 打包失败:', err.message);
  console.error(err);
  process.exit(1);
});