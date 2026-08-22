<script setup lang="ts">
import TopBar from '@/components/TopBar.vue';
import SideDrawer from '@/components/SideDrawer.vue';
import AppCarousel from '@/components/AppCarousel.vue';
import FeatureSection from '@/components/FeatureSection.vue';
import BottomTabBar from '@/components/BottomTabBar.vue';
import InputBar from '@/components/InputBar.vue';
import { aiApps, featureSections, bottomTabs } from '@/data/assistantFeatures';
import { useUiStore } from '@/stores/ui';

const ui = useUiStore();

// 离线场景：所有用户操作均占位
function onMenu() { ui.openDrawer(); }
function onNewChat() { console.log('new chat (offline)'); }
function onAppSelect(id: string) { ui.setActiveApp(id); }
function onTabSelect(id: string) { ui.setActiveTab(id); }
function onSend(_text: string) { console.log('send (offline)'); }
function onVoiceStart() { console.log('voice start (offline)'); }
function onVoiceEnd() { console.log('voice end (offline)'); }
function onCamera() { console.log('camera (offline)'); }
function onMore() { console.log('more (offline)'); }
</script>

<template>
  <div class="app-bg desktop-shell">
    <!-- 顶部导航 -->
    <TopBar @menu="onMenu" @new-chat="onNewChat" />

    <!-- 侧边抽屉 -->
    <SideDrawer v-model="ui.drawerOpen" />

    <!-- 主滚动区 -->
    <main class="main">
      <!-- AI 应用切换 -->
      <AppCarousel :apps="aiApps" @select="onAppSelect" />

      <!-- 三大功能区块 -->
      <div class="sections">
        <FeatureSection
          v-for="section in featureSections"
          :key="section.id"
          :section="section"
        />
      </div>
    </main>

    <!-- 底部 Tab 栏 -->
    <BottomTabBar :tabs="bottomTabs" @select="onTabSelect" />

    <!-- 底部输入栏 -->
    <InputBar
      @send="onSend"
      @voice-start="onVoiceStart"
      @voice-end="onVoiceEnd"
      @camera="onCamera"
      @more="onMore"
    />
  </div>
</template>

<style lang="scss" scoped>
.desktop-shell {
  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main {
  flex: 1;
  overflow-y: auto;
}

.sections {
  padding: 8px 0;
}
</style>