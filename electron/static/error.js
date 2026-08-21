// 错误页按钮：调 preload 暴露的 retry() 通过 IPC 通知主进程
document.getElementById('retry').addEventListener('click', () => {
  window.electronAPI.retry();
});

// 展示实际配置的 targetUrl（由主进程通过 URL query string 传入）
// 只显示 origin（host:port），路径会让提示变长且不必要 —— 用户关心的是「服务起没起」不是路径
// textContent 渲染，天然防 XSS（即使 targetUrl 含 < 也不会被解析）
const params = new URLSearchParams(window.location.search);
const rawTargetUrl = params.get('targetUrl') || '';
let display = rawTargetUrl;
try {
  // new URL 对畸形值会抛，catch 后回落到原始字符串
  display = new URL(rawTargetUrl).origin;
} catch { /* keep raw */ }
document.getElementById('target-url').textContent = display || '目标服务';
