import { defineStore } from 'pinia';
import { ref } from 'vue';
import { aiApps, bottomTabs } from '@/data/assistantFeatures';

/**
 * 纯 UI 状态 store。
 * 离线模式无登录态、无 API 调用，仅管理 drawer 开关 + 当前激活 tab + 在线连接状态。
 */
export const useUiStore = defineStore('ui', () => {
  const drawerOpen = ref(false);
  // 默认值取自 data 模块的第一个元素，避免硬编码 ID 漂移
  const activeTabId = ref<string>(bottomTabs[0].id);
  const activeAppId = ref<string>(aiApps[0].id);
  /**
   * 主进程是否正在尝试连接在线 URL。
   * - true：TopBar 显示「正在连接…」小 toast
   * - false：连接结束（成功已切到 contentView / 失败留在 offline 页，可点「重新连接」）
   *
   * dev 模式（npm run dev:offline）下无主进程，默认 false。
   */
  const isConnectingToOnline = ref(false);
  /**
   * 是否收到过主进程的首次推送。
   * - false（启动瞬间）：TopBar 显示 skeleton 占位，避免「重新连接」按钮误显
   * - true：按 isConnectingToOnline 切换 connecting / retry 状态
   *
   * 不重置：app 生命周期内只有首次启动需要这个 flag，重启后会重新为 false。
   */
  const hasReceivedFirstEvent = ref(false);

  function openDrawer() {
    drawerOpen.value = true;
  }
  function closeDrawer() {
    drawerOpen.value = false;
  }
  function setActiveTab(id: string) {
    activeTabId.value = id;
  }
  function setActiveApp(id: string) {
    activeAppId.value = id;
  }

  /**
   * 用户点击 TopBar「重新连接」按钮 → 通过 IPC 通知主进程重试。
   * 主进程收到后会自动先发 'show' 再 reload，所以这里不需要手动改 isConnectingToOnline。
   *
   * dev 模式下无 electronAPI，仅记录日志。
   */
  function retryOnline() {
    if (window.electronAPI) {
      window.electronAPI.retryOnline();
    } else {
      console.log('[ui] retryOnline (dev mode, no IPC)');
    }
  }

  /**
   * 订阅主进程推送的「URL 加载状态」。
   * 必须在 setup 顶层调用（Pinia store 创建时执行一次）。
   *
   * dev 模式下无 electronAPI，跳过订阅，isConnectingToOnline 保持 false。
   *
   * HMR 处理：返回的 unsubscribe 在 import.meta.hot.dispose() 时调用，
   * 避免 Vite HMR 重新 setup 时 listener 累积。
   */
  if (window.electronAPI) {
    const unsubscribe = window.electronAPI.onLoadingStateChange((state) => {
      isConnectingToOnline.value = state === 'show';
      hasReceivedFirstEvent.value = true;
    });
    // HMR 清理：旧 store 销毁时清掉 listener
    if (import.meta.hot) {
      import.meta.hot.dispose(() => unsubscribe());
    }
  }

  return {
    drawerOpen,
    activeTabId,
    activeAppId,
    isConnectingToOnline,
    hasReceivedFirstEvent,
    openDrawer,
    closeDrawer,
    setActiveTab,
    setActiveApp,
    retryOnline,
  };
});
