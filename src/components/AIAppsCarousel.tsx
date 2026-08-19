import React, { useState } from 'react';
import { aiApps } from '../data/features';

export const AIAppsCarousel: React.FC = () => {
  const [activeId, setActiveId] = useState(aiApps[0].id);

  return (
    // 三层嵌套：外层 padding 留空间 → 中层滚动 → 内层 padding + 按钮
    <div className="px-3 py-3 overflow-hidden">
      <div className="overflow-x-auto scrollbar-hide">
        <div className="flex gap-2 px-3 py-3 min-w-max">
          {aiApps.map((app) => {
            const isActive = activeId === app.id;
            return (
              <button
                key={app.id}
                onClick={() => setActiveId(app.id)}
                className="flex flex-col items-center gap-1.5 flex-shrink-0 p-2 transition-transform hover:scale-110 active:scale-95"
              >
                <div
                  className={`w-12 h-12 rounded-2xl ${app.bgColor} flex items-center justify-center text-white font-semibold text-lg transition-all duration-200`}
                  style={{
                    // outline 不会被 overflow 裁剪！
                    outline: isActive ? '2px solid #60A5FA' : '2px solid transparent',
                    outlineOffset: '4px',
                    // box-shadow 只负责发光（hover 时），不画环
                    boxShadow: isActive
                      ? '0 0 12px rgba(96, 165, 250, 0.5), 0 8px 16px rgba(0, 0, 0, 0.15)'
                      : '0 4px 8px rgba(0, 0, 0, 0.08)',
                  }}
                >
                  {app.icon}
                </div>
                <span className="text-xs text-gray-700 font-medium">{app.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
