<script setup lang="ts">
/**
 * FeatureCard — 单个功能卡片(纯展示,无 router/store)
 *
 * 父组件传入 card 数据;点击只 emit('click'),无下游行为(离线场景)。
 */
import type { FeatureCard } from '@/data/assistantFeatures'

defineProps<{
  card: FeatureCard
}>()

defineEmits<{
  click: []
}>()
</script>

<template>
  <button type="button" class="feature-card" @click="$emit('click')">
    <div
      class="feature-icon"
      :style="{ backgroundColor: card.iconBg }"
    >
      {{ card.icon }}
    </div>
    <div class="feature-text">
      <div class="feature-title">{{ card.title }}</div>
      <div class="feature-desc">{{ card.desc }}</div>
    </div>
  </button>
</template>

<style lang="scss" scoped>
.feature-card {
  display: flex;
  align-items: center;
  gap: 12px; /* gap-3 */
  padding: 12px; /* p-3 */
  border: none;
  border-radius: 16px; /* rounded-2xl */
  background: rgba(255, 255, 255, 0.8); /* bg-white/80 */
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
  transition: background-color 200ms, box-shadow 200ms;

  &:hover {
    background: #ffffff;
    box-shadow: var(--macapp-shadow-card-hover); /* hover:shadow-card-hover */
  }
}

.feature-icon {
  width: 44px; /* w-11 */
  height: 44px;
  border-radius: 12px; /* rounded-xl */
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px; /* text-2xl ≈ 22px */
  flex-shrink: 0;
}

.feature-text {
  flex: 1;
  min-width: 0;
}

.feature-title {
  font-size: 14px; /* text-sm */
  font-weight: 600;
  color: #111827; /* text-gray-900 */
  line-height: 1.4;
}

.feature-desc {
  font-size: 12px; /* text-xs */
  color: #6b7280; /* text-gray-500 */
  margin-top: 2px; /* mt-0.5 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis; /* truncate */
}
</style>