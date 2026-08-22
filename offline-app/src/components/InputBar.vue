<script setup lang="ts">
/**
 * InputBar — 底部输入栏(语音 + 文本 + 拍照 + 更多,离线场景)
 *
 * 无 router/store 依赖;发送 / 语音 / 拍照 / 更多 全部走 emit,
 * 由父组件(App.vue)监听,离线模式下父组件仅 console.log 占位。
 */
import { ref } from 'vue'

const text = ref('')
const isRecording = ref(false)

const emit = defineEmits<{
  send: [text: string]
  voiceStart: []
  voiceEnd: []
  camera: []
  more: []
}>()

function onInput(e: Event) {
  text.value = (e.target as HTMLInputElement).value
}

function onSend() {
  const t = text.value.trim()
  if (!t) return
  emit('send', t)
  text.value = ''
}

function onVoiceStart() {
  isRecording.value = true
  emit('voiceStart')
}

function onVoiceEnd() {
  isRecording.value = false
  emit('voiceEnd')
}
</script>

<template>
  <div class="inputbar-wrap">
    <div class="inputbar glass-card">
      <!-- 语音按钮 -->
      <button
        type="button"
        class="icon-btn"
        :class="{ 'is-recording': isRecording }"
        aria-label="语音输入"
        @mousedown="onVoiceStart"
        @mouseup="onVoiceEnd"
        @mouseleave="onVoiceEnd"
      >
        <svg v-if="isRecording" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="6" />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>

      <!-- 输入框 -->
      <input
        type="text"
        :value="text"
        placeholder="发消息或按住说话"
        class="text-input"
        @input="onInput"
        @keydown.enter="onSend"
      />

      <!-- 拍照按钮 -->
      <button
        type="button"
        class="icon-btn"
        aria-label="拍照"
        @click="$emit('camera')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>

      <!-- 更多按钮 -->
      <button
        type="button"
        class="icon-btn"
        aria-label="更多"
        @click="$emit('more')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.inputbar-wrap {
  padding: 8px 24px 20px; /* px-6 pb-5 pt-2 */
}

.inputbar {
  border-radius: 16px; /* rounded-2xl */
  display: flex;
  align-items: center;
  gap: 8px; /* gap-2 */
  padding: 10px 12px; /* 略大于 py-2 px-3,补偿行高 */
}

.icon-btn {
  flex-shrink: 0;
  width: 36px; /* w-9 */
  height: 36px;
  border: none;
  border-radius: 9999px; /* rounded-full */
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f3f4f6; /* bg-gray-100 */
  color: #4b5563; /* text-gray-600 */
  cursor: pointer;
  transition: background-color 200ms, transform 200ms;

  &:hover {
    background: #e5e7eb; /* hover:bg-gray-200 */
  }

  &.is-recording {
    background: #ef4444; /* bg-red-500 */
    color: #ffffff;
    transform: scale(1.1);
  }
}

.text-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  padding: 0 8px; /* px-2 */
  font-size: 14px; /* text-sm */
  color: #111827; /* text-gray-900 */
  line-height: 1.5;

  &::placeholder {
    color: #9ca3af; /* placeholder-gray-400 */
  }
}
</style>