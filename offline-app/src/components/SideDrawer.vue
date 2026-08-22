<script setup lang="ts">
/**
 * SideDrawer — 左侧抽屉(离线模式精简版)
 *
 * 原始 AssistantSideDrawer 有完整登录态(用户名下拉、退出、跳转控制台、智能体广场等)。
 * 离线场景无登录态、无 router,故全部去掉:
 *  - 仅保留品牌行 + 「未登录」文案 + el-button 登录占位
 *  - 所有跳转 / 登录 / 退出登录都走 console.log 占位
 */
defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
}>()

/** 登录入口(离线场景):仅占位,不弹窗、不跳转 */
function openLogin() {
  emit('update:modelValue', false)
  // eslint-disable-next-line no-console
  console.log('login clicked (offline)')
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    direction="ltr"
    :with-header="false"
    size="280px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="drawer-body">
      <!-- 品牌名 -->
      <div class="brand-row">
        <strong class="brand">AI 协作平台</strong>
      </div>

      <!-- 离线场景固定未登录:文案 + el-button 占位 -->
      <div class="login-area">
        <span class="login-status">未登录</span>
        <el-button
          type="primary"
          size="small"
          data-test="side-drawer-login"
          @click="openLogin"
        >登录</el-button>
      </div>
    </div>
  </el-drawer>
</template>

<style lang="scss" scoped>
.drawer-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 20px;
  height: 100%;
}

.brand-row {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--color-border-subtle, #e5e7eb);
}
.brand {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text, #111827);
}

/* 登录区 —— 文案 + 按钮 */
.login-area {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.login-status {
  font-size: 14px;
  color: var(--color-text-secondary, #4b5563);
}
</style>