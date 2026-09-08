<script setup lang="ts">
/**
 * ToolPickerDialog — 自渲染 ElDialog 列出所有 codingAgent.tools
 *
 * 用户点 tool 按钮 → emit('select', tool)；点取消 → emit('cancel')。
 *
 * 元素：ElDialog 全局注册（main.ts app.use(ElementPlus)），无需局部 import。
 */
import type { CodingTool } from '@/types/coding'

defineProps<{
  visible: boolean
  tools: CodingTool[]
}>()

const emit = defineEmits<{
  select: [tool: CodingTool]
  cancel: []
}>()

function badge(type: CodingTool['type']): string {
  return type === 'embedded' ? '🌐 内嵌' : '🚀 外部'
}
</script>

<template>
  <ElDialog
    :model-value="visible"
    title="选择编码工具"
    width="480px"
    :show-close="true"
    :close-on-click-modal="true"
    @update:model-value="(v: boolean) => { if (!v) emit('cancel') }"
  >
    <div class="tool-list">
      <button
        v-for="tool in tools"
        :key="tool.id"
        type="button"
        class="tool-btn"
        @click="emit('select', tool)"
      >
        <div class="tool-row">
          <span class="tool-badge">{{ badge(tool.type) }}</span>
          <span class="tool-name">{{ tool.name }}</span>
        </div>
        <div v-if="tool.description" class="tool-desc">{{ tool.description }}</div>
      </button>
    </div>
  </ElDialog>
</template>

<style lang="scss" scoped>
.tool-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-btn {
  padding: 12px 16px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #ffffff;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition: background-color 150ms, border-color 150ms;

  &:hover {
    background: #f9fafb;
    border-color: #93c5fd;
  }
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-badge {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 6px;
  background: #eff6ff;
  color: #2563eb;
}

.tool-name {
  font-size: 14px;
  font-weight: 600;
}

.tool-desc {
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}
</style>
