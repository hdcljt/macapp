<script setup lang="ts">
/**
 * TopBar — 离线页顶部菜单 + 在线连接状态 + 新建对话
 *
 * 连接状态来自 ui store（主进程 IPC 推过来）：
 * - isConnectingToOnline=true → 显示「正在连接…」spinner toast
 * - isConnectingToOnline=false 且不在 contentView → 显示「重新连接」按钮（点击触发 retryOnline）
 *
 * 注：源项目有 -webkit-app-region: drag 拖拽行为（Electron 桌面壳）；
 * 此处为 Web 端环境，丢弃拖拽相关样式。
 *
 * hamburger 按钮点击 → emit('menu')，由父组件打开 SideDrawer
 */
import { useUiStore } from '@/stores/ui'
import { storeToRefs } from 'pinia'

defineEmits<{
  menu: []
  newChat: []
}>()

const uiStore = useUiStore()
const { isConnectingToOnline } = storeToRefs(uiStore)
</script>

<template>
  <header class="topbar">
    <!-- 左侧菜单按钮 -->
    <button
      type="button"
      class="icon-btn"
      aria-label="菜单"
      @click="$emit('menu')"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="12" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>

    <!-- 右侧：连接状态 toast + 新建对话 -->
    <div class="actions">
      <!--
        连接状态提示：
        - 正在连接：spinner + 文字，自动出现/消失
        - 连接失败（用户停留在 offline 页且不再连接中）：显示「重新连接」按钮
      -->
      <Transition name="toast">
        <div
          v-if="isConnectingToOnline"
          class="toast toast--connecting"
          role="status"
          aria-live="polite"
        >
          <span class="spinner" aria-hidden="true" />
          <span class="toast-text">正在连接在线服务…</span>
        </div>
        <button
          v-else
          type="button"
          class="toast toast--retry"
          aria-label="重新连接在线服务"
          @click="uiStore.retryOnline()"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          <span class="toast-text">重新连接</span>
        </button>
      </Transition>

      <button
        type="button"
        class="icon-btn"
        aria-label="新建对话"
        @click="$emit('newChat')"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <line x1="12" y1="8" x2="12" y2="14" />
          <line x1="9" y1="11" x2="15" y2="11" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style lang="scss" scoped>
@use '@/styles/variables.scss' as *;

.topbar {
  position: relative;
  height: 56px; /* h-14 */
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: transparent;
}

.icon-btn {
  width: 36px; /* w-9 */
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  color: inherit;
  transition: background-color 200ms;

  &:hover {
    background: rgba(255, 255, 255, 0.4); /* hover:bg-white/40 */
  }
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ---- 连接状态 toast ---- */
.toast {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 16px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  border: none;
  cursor: default;
  user-select: none;
  transition: background-color 200ms, color 200ms, box-shadow 200ms;

  &--connecting {
    background: rgba(96, 165, 250, 0.12); /* 浅蓝底 */
    color: $color-accent;
    box-shadow: 0 1px 2px rgba(96, 165, 250, 0.1);
    pointer-events: none; /* 加载中不可点 */
  }

  &--retry {
    background: rgba(255, 255, 255, 0.5);
    color: $color-text-secondary;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);

    &:hover {
      background: rgba(96, 165, 250, 0.12);
      color: $color-accent;
    }
  }
}

.toast-text {
  white-space: nowrap;
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ---- 进入/离开过渡 ---- */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
