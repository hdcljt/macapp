<script setup lang="ts">
/**
 * FeatureSection — 功能区块(虚线边框 + 2x2 卡片网格)
 *
 * 父组件通过 section prop 传入 FeatureSection 数据,
 * 内部仅展示,无外部依赖。
 */
import type { FeatureSection } from '@/data/assistantFeatures'
import FeatureCard from './FeatureCard.vue'

defineProps<{
  section: FeatureSection
}>()
</script>

<template>
  <section class="feature-section">
    <!-- 区块标题 -->
    <div class="section-header">
      <div class="section-title-row">
        <h2 class="section-title">{{ section.title }}</h2>
        <span class="section-emoji">{{ section.headerIcon }}</span>
      </div>
      <p class="section-subtitle">{{ section.subtitle }}</p>
    </div>

    <!-- 功能卡片网格 2x2 -->
    <div class="card-grid">
      <FeatureCard
        v-for="card in section.cards"
        :key="card.title"
        :card="card"
      />
    </div>
  </section>
</template>

<style lang="scss" scoped>
.feature-section {
  margin: 0 24px 16px; /* mx-6 mb-4 */
  border-radius: 24px; /* rounded-3xl */
  border: 1px dashed rgba(252, 165, 165, 0.6); /* border-dashed border-red-300/60 */
  padding: 16px; /* p-4 */
  background: rgba(255, 255, 255, 0.3); /* bg-white/30 */
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px; /* mb-3 */
  padding: 0 4px; /* px-1 */
}

.section-title-row {
  display: flex;
  align-items: center;
  gap: 8px; /* gap-2 */
}

.section-title {
  margin: 0;
  font-size: 18px; /* text-lg */
  font-weight: 700;
  color: #111827;
}

.section-emoji {
  font-size: 20px; /* text-xl */
  line-height: 1;
}

.section-subtitle {
  margin: 2px 0 0; /* mt-0.5 */
  font-size: 12px; /* text-xs */
  color: #6b7280;
}

.card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr; /* grid-cols-2 */
  gap: 10px; /* gap-2.5 */
}
</style>