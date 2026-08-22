// 解析主进程通过 URL query string 传入的版本信息
// （替代之前的 process.argv + additionalArguments：sandboxed renderer 不保证 process.argv 可用，
//  否则第 2 行 process.argv.filter 会抛 TypeError，导致整个脚本崩在按钮事件绑定之前 → 按钮无响应）
const params = new URLSearchParams(window.location.search);
const latestVersion = params.get('version') || '';
const notes = params.get('notes') || '';

// Electron 环境下由 preload.ts 注入 window.electronAPI；浏览器/PDF/单测里不存在。
// 用 optional chaining + fallback 兜底，避免顶层 TypeError 把整个脚本挂掉
// （notes / buttons 等后续渲染都依赖当前 script 跑到底才能生效）。
const api = window.electronAPI;

// 当前版本经 IPC 取（process.env.npm_package_version 在打包后丢失）
api?.versions?.app?.()?.then((v) => {
  document.getElementById('current').textContent = v || '?';
})?.catch?.(() => {
  document.getElementById('current').textContent = '?';
});
document.getElementById('latest').textContent = latestVersion || '?';

// Release notes：弹窗拿到的 notes 是 GitHub atom feed <content type="html"> 节点的值，
// 即 GitHub 服务端把 release body markdown 渲染后的 HTML 字符串（含 <ul><li> 等）。
// 之前的 mdToSafeHtml 把 HTML 当 markdown 处理会被全部转义成字面字符（&lt;ul&gt; 显示成 "<ul>"），
// 而且即使输入是 markdown，双层转换（GitHub 已渲染一次 + 我们再渲染）也是浪费。
// 改用纯文本路线：DOMParser 解析 HTML → 提取文本，<li> 转 • 、<br>/<p> 转换行。
// textContent 直接写入避免 XSS（无 HTML 注入面）。
function renderReleaseNotes(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push(child.textContent);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'li') {
          out.push('\n• ');
          walk(child);
        } else if (tag === 'br') {
          out.push('\n');
        } else if (tag === 'p' || tag === 'div') {
          out.push('\n');
          walk(child);
          out.push('\n');
        } else {
          walk(child);
        }
      }
    }
  };
  walk(doc.body);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}
document.getElementById('notes').textContent = renderReleaseNotes(notes) || '本次更新包含若干改进与问题修复。';

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
api?.updater?.onProgress?.((pct) => {
  progressWrap.hidden = false;
  const rounded = Math.round(pct);
  fill.style.width = rounded + '%';
  progressLabel.textContent = rounded + '%';
});

// 下载完成 → 显示「立即安装」按钮
api?.updater?.onDownloaded?.(() => {
  progressWrap.hidden = true;
  btnUpdate.hidden   = true;
  btnInstall.hidden  = false;
  btnLater.disabled  = false;
});

// 错误事件
api?.updater?.onError?.((msg) => {
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
    await api?.updater?.download?.();
  } catch (err) {
    errorMsg.hidden = false;
    errorMsg.textContent = '启动下载失败：' + (err.message || err);
    btnUpdate.disabled = false;
    btnLater.disabled  = false;
  }
});

// 点击「立即安装」
btnInstall.addEventListener('click', () => {
  if (api?.platform === 'darwin') {
    // macOS：electron-updater 的 quitAndInstall 会自动解压缓存的 zip、替换 .app、再启动。
    // 不需要用户去 Finder 找 .dmg / .zip（更不存在「下载文件夹」这回事——缓存路径是
    // ~/Library/Caches/<appName>/Updater/）。简短提示让用户知道会自动退出+重启。
    alert('即将退出当前应用并自动安装更新，几秒后会自动启动新版本。');
  }
  api?.updater?.install?.();
});

// 点击「以后再说」
btnLater.addEventListener('click', () => {
  api?.updater?.dismiss?.(version);
});