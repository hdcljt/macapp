<script setup lang="ts">
/**
 * TopBar — 离线页顶部菜单 + 新建对话
 *
 * 注：源项目有 -webkit-app-region: drag 拖拽行为（Electron 桌面壳）；
 * 此处为 Web 端环境，丢弃拖拽相关样式。
 *
 * hamburger 按钮点击 → emit('menu')，由父组件打开 SideDrawer
 * （离线模式下仅显示品牌行 + 「未登录」 + 登录占位按钮）。
 */
defineEmits<{
  menu: []
  newChat: []
}>()
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
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>

    <!-- 右侧操作按钮 -->
    <div class="actions">
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
.topbar {
  position: relative;
  height: 56px; /* h-14 */
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px; /* Web 端用 24px(对应源 Win 分支);Electron Mac 用 78px,此处丢弃 */
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
</style>