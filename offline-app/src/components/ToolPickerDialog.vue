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
  if (type === 'embedded') return '🌐 内嵌'
  if (type === 'url') return '🔗 URL'
  return '🚀 外部'
}

/**
 * 显示启动命令摘要：
 * - external: path || command + args（dirMode 仅影响 spawn 实现，dialog 不展开）
 * - embedded: command + args（args 已含 <port> 占位符模板）
 * - url: 完整 url
 * - 若 tool.description 非空，覆盖命令摘要（让用户可选自定义显示文案）
 */
function commandSummary(tool: CodingTool): string {
  if (tool.description && tool.description.length > 0) return tool.description;
  if (tool.type === 'url') return tool.url;

  const cmd = tool.path && tool.path.length > 0 ? tool.path : tool.command;
  const args = tool.args ?? [];
  return [cmd, ...args].join(' ').trim();
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
        <div class="tool-desc">{{ commandSummary(tool) }}</div>
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
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace;

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
  font-family: inherit;  // badge 不走 monospace
}

.tool-name {
  font-size: 14px;
  font-weight: 600;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;  // name 用系统字体
}

.tool-desc {
  margin-top: 6px;
  font-size: 12px;
  color: #6b7280;
  word-break: break-all;
  line-height: 1.4;
}
</style>
