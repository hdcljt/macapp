// 错误页按钮：调 preload 暴露的 retry() 通过 IPC 通知主进程
document.getElementById('retry').addEventListener('click', () => {
  window.electronAPI.retry();
});
