<script setup lang="ts">
/**
 * AppCarousel — AI 应用横向滚动(离线场景)
 *
 * 数据由父组件通过 apps prop 传入;当前激活项走 ui store,
 * 选中后 emit('select', id),由父组件决定后续动作(目前离线模式无下游行为)。
 */
import { useUiStore } from '@/stores/ui'
import type { AIApp } from '@/data/assistantFeatures'

defineProps<{
  apps: AIApp[]
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

const uiStore = useUiStore()

function handleClick(id: string) {
  uiStore.setActiveApp(id)
  emit('select', id)
}
</script>

<template>
  <!-- 三层嵌套:外层 padding 留空间 → 中层滚动 → 内层 padding + 按钮 -->
  <div class="carousel">
    <div class="scroll">
      <div class="track">
        <button
          v-for="app in apps"
          :key="app.id"
          type="button"
          class="app-btn"
          @click="handleClick(app.id)"
        >
          <div
            class="app-icon"
            :class="{ 'is-active': uiStore.activeAppId === app.id }"
            :style="{ backgroundColor: app.bgColor }"
          >
            {{ app.icon }}
          </div>
          <span class="app-name">{{ app.name }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.carousel {
  padding: 12px; /* px-3 py-3 */
  overflow: hidden;
}
.scroll {
  overflow-x: auto;
}
.track {
  display: flex;
  gap: 8px; /* gap-2 */
  padding: 12px; /* px-3 py-3 */
  min-width: max-content;
}

.app-btn {
  flex-shrink: 0;
  padding: 8px; /* p-2 */
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px; /* gap-1.5 */
  transition: transform 200ms;

  &:hover { transform: scale(1.1); } /* hover:scale-110 */
  &:active { transform: scale(0.95); } /* active:scale-95 */
}

.app-icon {
  width: 48px; /* w-12 */
  height: 48px;
  border-radius: 16px; /* rounded-2xl */
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  font-weight: 600;
  font-size: 18px; /* text-lg */
  transition: all 200ms;
  outline: 2px solid transparent;
  outline-offset: 4px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.08);

  &.is-active {
    /* outline 不会被 overflow 裁剪! */
    outline: 2px solid var(--macapp-active-blue);
    /* box-shadow 只负责发光(hover 时),不画环 */
    box-shadow:
      0 0 12px var(--macapp-active-glow),
      0 8px 16px rgba(0, 0, 0, 0.15);
  }
}

.app-name {
  font-size: 12px; /* text-xs */
  color: #374151; /* text-gray-700 */
  font-weight: 500;
}
</style>