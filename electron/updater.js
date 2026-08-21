// 解析 preload 通过 additionalArguments 传入的版本信息
const args = process.argv.filter(a => a.startsWith('--update-'));
const getArg = (key) => {
  const arg = args.find(a => a.startsWith(`--update-${key}=`));
  if (!arg) return '';
  return decodeURIComponent(arg.split('=').slice(1).join('='));
};

const isMac = window.electronAPI.platform === 'darwin';

// 填充版本号（当前版本从 preload 注入的 versions.app 读取，异步 IPC）
window.electronAPI.versions.app().then((v) => {
  document.getElementById('current').textContent = v || '?';
}).catch(() => {
  document.getElementById('current').textContent = '?';
});
document.getElementById('latest').textContent  = getArg('version') || '?';

// 显示 release notes（原始字符串；无格式化渲染）
const notesText = getArg('notes');
document.getElementById('notes').textContent = notesText || '本次更新包含若干改进与问题修复。';

// DOM 引用
const btnUpdate   = document.getElementById('btn-update');
const btnInstall  = document.getElementById('btn-install');
const btnLater    = document.getElementById('btn-later');
const progressWrap = document.getElementById('progress-wrap');
const progressLabel = document.getElementById('progress-label');
const fill = document.getElementById('fill');
const errorMsg = document.getElementById('error-msg');
const version = getArg('version');

// 进度事件
window.electronAPI.updater.onProgress((pct) => {
  progressWrap.style.display = 'block';
  const rounded = Math.round(pct);
  fill.style.width = rounded + '%';
  progressLabel.textContent = `下载中… ${rounded}%`;
});

// 下载完成 → 显示「立即安装」按钮
window.electronAPI.updater.onDownloaded(() => {
  progressWrap.style.display = 'none';
  btnUpdate.style.display   = 'none';
  btnInstall.style.display  = 'inline-block';
  btnLater.disabled         = false;
});

// 错误事件
window.electronAPI.updater.onError((msg) => {
  errorMsg.style.display = 'block';
  errorMsg.textContent = `下载失败：${msg}\n请前往 GitHub Releases 手动下载最新版本。`;
  btnUpdate.disabled = false;
  btnLater.disabled  = false;
});

// 点击「立即更新」
btnUpdate.addEventListener('click', async () => {
  btnUpdate.disabled = true;
  btnLater.disabled  = true;
  try {
    await window.electronAPI.updater.download();
  } catch (err) {
    errorMsg.style.display = 'block';
    errorMsg.textContent = '启动下载失败：' + (err.message || err);
    btnUpdate.disabled = false;
    btnLater.disabled  = false;
  }
});

// 点击「立即安装」
btnInstall.addEventListener('click', () => {
  if (isMac) {
    alert(
      '更新包已下载到「下载」文件夹（macOS 上 electron-updater 会放到 cache 目录）。\n' +
      '请退出当前应用后：\n' +
      '1. 打开 Finder → 找到新版本的 .dmg 或 .zip\n' +
      '2. 双击挂载，将「算粒AI助手」拖入「应用程序」文件夹\n' +
      '3. 在「应用程序」中启动新版本'
    );
  }
  window.electronAPI.updater.install();
});

// 点击「以后再说」
btnLater.addEventListener('click', () => {
  window.electronAPI.updater.dismiss(version);
});
