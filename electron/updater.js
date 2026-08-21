// 解析主进程通过 URL query string 传入的版本信息
// （替代之前的 process.argv + additionalArguments：sandboxed renderer 不保证 process.argv 可用，
//  否则第 2 行 process.argv.filter 会抛 TypeError，导致整个脚本崩在按钮事件绑定之前 → 按钮无响应）
const params = new URLSearchParams(window.location.search);
const latestVersion = params.get('version') || '';
const notes = params.get('notes') || '';

// 填充版本号（当前版本从 preload 注入的 versions.app 读取，异步 IPC）
window.electronAPI.versions.app().then((v) => {
  document.getElementById('current').textContent = v || '?';
}).catch(() => {
  document.getElementById('current').textContent = '?';
});
document.getElementById('latest').textContent = latestVersion || '?';

// 显示 release notes：用 textContent 渲染（不解析 markdown / HTML），
// 天然防 XSS — 即使 GitHub release body 含 <script> 也只会显示为纯文本。
document.getElementById('notes').textContent = notes || '本次更新包含若干改进与问题修复。';

// DOM 引用
const btnUpdate   = document.getElementById('btn-update');
const btnInstall  = document.getElementById('btn-install');
const btnLater    = document.getElementById('btn-later');
const progressWrap = document.getElementById('progress-wrap');
const progressLabel = document.getElementById('progress-label');
const fill = document.getElementById('fill');
const errorMsg = document.getElementById('error-msg');
const version = latestVersion;

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
  btnUpdate.hidden   = true;
  btnInstall.hidden  = false;
  btnLater.disabled  = false;
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
  if (window.electronAPI.platform === 'darwin') {
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
