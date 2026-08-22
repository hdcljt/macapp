<script setup lang="ts">
/**
 * BottomTabBar — 底部 4 个 tab(离线场景)
 *
 * tabs 由父组件传入;当前激活项走 ui store;
 * 选中后 emit('select', id),由父组件决定后续动作。
 */
import { useUiStore } from '@/stores/ui'
import type { BottomTab } from '@/data/assistantFeatures'

defineProps<{
  tabs: BottomTab[]
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

const uiStore = useUiStore()

function handleClick(id: string) {
  uiStore.setActiveTab(id)
  emit('select', id)
}
</script>

<template>
  <div class="tabbar-wrap">
    <div class="tabbar glass-card">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="tab"
        :class="{ 'is-active': uiStore.activeTabId === tab.id }"
        @click="handleClick(tab.id)"
      >
        <span class="tab-icon">{{ tab.icon }}</span>
        <span class="tab-label">{{ tab.name }}</span>
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tabbar-wrap {
  padding: 8px 24px; /* px-6 py-2 */
}

.tabbar {
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 10px; /* 略大于 py-2,补偿行高差异 */
  border-radius: 16px; /* rounded-2xl */
  /* .glass-card 已在 template 上挂上 */
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px; /* gap-1.5 */
  padding: 8px 14px; /* 略大于 py-1.5 px-3,补偿行高 */
  border: none;
  border-radius: 12px; /* rounded-xl */
  background: transparent;
  cursor: pointer;
  color: #4b5563; /* text-gray-600 */
  font: inherit;
  line-height: 1.5;
  transition: background-color 200ms, color 200ms;

  &:hover {
    background: rgba(255, 255, 255, 0.5); /* hover:bg-white/50 */
  }

  &.is-active {
    background: #3b82f6; /* bg-blue-500 */
    color: #ffffff; /* text-white */
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); /* shadow-md */
  }
}

.tab-icon {
  font-size: 16px; /* text-base */
  line-height: 1;
}

.tab-label {
  font-size: 12px; /* text-xs */
  font-weight: 500;
}
</style>