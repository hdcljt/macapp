import React from 'react';
import { TopBar } from './components/TopBar';
import { AIAppsCarousel } from './components/AIAppsCarousel';
import { FeatureSection } from './components/FeatureSection';
import { BottomTabBar } from './components/BottomTabBar';
import { InputBar } from './components/InputBar';
import { featureSections } from './data/features';

const App: React.FC = () => {
  return (
    <div className="app-bg h-screen w-screen flex flex-col overflow-hidden">
      {/* 顶部导航 */}
      <TopBar />

      {/* 主内容区域 */}
      <main className="flex-1 overflow-y-auto scrollbar-hide">
        {/* AI 应用切换 */}
        <AIAppsCarousel />

        {/* 三大功能区块 */}
        <div className="py-2">
          {featureSections.map((section) => (
            <FeatureSection key={section.id} section={section} />
          ))}
        </div>
      </main>

      {/* 底部 Tab 栏 */}
      <BottomTabBar />

      {/* 底部输入栏 */}
      <InputBar />
    </div>
  );
};

export default App;
