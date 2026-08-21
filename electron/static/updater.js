// 解析主进程通过 URL query string 传入的版本信息
// （替代之前的 process.argv + additionalArguments：sandboxed renderer 不保证 process.argv 可用，
//  否则第 2 行 process.argv.filter 会抛 TypeError，导致整个脚本崩在按钮事件绑定之前 → 按钮无响应）
const params = new URLSearchParams(window.location.search);
const latestVersion = params.get('version') || '';
const notes = params.get('notes') || '';

// 当前版本经 IPC 取（process.env.npm_package_version 在打包后丢失）
window.electronAPI.versions.app().then((v) => {
  document.getElementById('current').textContent = v || '?';
}).catch(() => {
  document.getElementById('current').textContent = '?';
});
document.getElementById('latest').textContent = latestVersion || '?';

// Release notes：GitHub Release 的 body 是 markdown（workflow 用 commit subjects 生成）。
// 这里做一个轻量的 markdown → 安全 HTML 转换：
//   - 全部用户输入先 HTML 转义
//   - 仅生成白名单标签：<p> <ul> <ol> <li> <strong> <em> <code>
//   - 不引入 marked/DOMPurify 等依赖，体积 0
// CSP `script-src 'self'` 兜底，innerHTML 即便含 <script> 也不会执行
function mdToSafeHtml(md) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  // inline：在已转义文本上做加粗/斜体/code 替换
  const inline = (s) => {
    let r = s;
    r = r.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    r = r.replace(/(^|[^*\w])\*([^*\n]+?)\*/g, '$1<em>$2</em>');
    r = r.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
    return r;
  };

  const lines = md.split(/\r?\n/);
  const out = [];
  let paraBuf = [];
  let listType = null; // 'ul' | 'ol' | null

  const flushPara = () => {
    if (paraBuf.length) {
      out.push('<p>' + inline(esc(paraBuf.join(' '))) + '</p>');
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (listType) { out.push('</' + listType + '>'); listType = null; }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flushPara();
      closeList();
      continue;
    }
    const ul = /^[-\*]\s+(.+)$/.exec(line);
    const ol = /^(\d+)\.\s+(.+)$/.exec(line);
    if (ul) {
      flushPara();
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push('<li>' + inline(esc(ul[1])) + '</li>');
    } else if (ol) {
      flushPara();
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push('<li>' + inline(esc(ol[2])) + '</li>');
    } else {
      closeList();
      paraBuf.push(line);
    }
  }
  flushPara();
  closeList();
  return out.join('');
}
document.getElementById('notes').innerHTML = mdToSafeHtml(notes) || '本次更新包含若干改进与问题修复。';

// DOM 引用
const btnUpdate    = document.getElementById('btn-update');
const btnInstall   = document.getElementById('btn-install');
const btnLater     = document.getElementById('btn-later');
const progressWrap = document.getElementById('progress-wrap');
const progressLabel = document.getElementById('progress-label');
const fill         = document.getElementById('fill');
const errorMsg     = document.getElementById('error-msg');
const version      = latestVersion;

// 进度事件
window.electronAPI.updater.onProgress((pct) => {
  progressWrap.hidden = false;
  const rounded = Math.round(pct);
  fill.style.width = rounded + '%';
  progressLabel.textContent = rounded + '%';
});

// 下载完成 → 显示「立即安装」按钮
window.electronAPI.updater.onDownloaded(() => {
  progressWrap.hidden = true;
  btnUpdate.hidden   = true;
  btnInstall.hidden  = false;
  btnLater.disabled  = false;
});

// 错误事件
window.electronAPI.updater.onError((msg) => {
  errorMsg.hidden = false;
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
    errorMsg.hidden = false;
    errorMsg.textContent = '启动下载失败：' + (err.message || err);
    btnUpdate.disabled = false;
    btnLater.disabled  = false;
  }
});

// 点击「立即安装」
btnInstall.addEventListener('click', () => {
  if (window.electronAPI.platform === 'darwin') {
    // macOS：electron-updater 的 quitAndInstall 会自动解压缓存的 zip、替换 .app、再启动。
    // 不需要用户去 Finder 找 .dmg / .zip（更不存在「下载文件夹」这回事——缓存路径是
    // ~/Library/Caches/<appName>/Updater/）。简短提示让用户知道会自动退出+重启。
    alert('即将退出当前应用并自动安装更新，几秒后会自动启动新版本。');
  }
  window.electronAPI.updater.install();
});

// 点击「以后再说」
btnLater.addEventListener('click', () => {
  window.electronAPI.updater.dismiss(version);
});