import { defineStore } from 'pinia';
import { ref } from 'vue';
import { aiApps, bottomTabs } from '@/data/assistantFeatures';

/**
 * 纯 UI 状态 store。
 * 离线模式无登录态、无 API 调用，仅管理 drawer 开关 + 当前激活 tab 等纯前端状态。
 */
export const useUiStore = defineStore('ui', () => {
  const drawerOpen = ref(false);
  // 默认值取自 data 模块的第一个元素，避免硬编码 ID 漂移
  const activeTabId = ref<string>(bottomTabs[0].id);
  const activeAppId = ref<string>(aiApps[0].id);

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

  return {
    drawerOpen,
    activeTabId,
    activeAppId,
    openDrawer,
    closeDrawer,
    setActiveTab,
    setActiveApp,
  };
});
