import React, { useState } from 'react';
import { bottomTabs } from '../data/features';

export const BottomTabBar: React.FC = () => {
  const [activeId, setActiveId] = useState(bottomTabs[0].id);

  return (
    <div className="px-6 py-2">
      <div className="flex items-center justify-around glass-card rounded-2xl py-2 px-2">
        {bottomTabs.map((tab) => {
          const isActive = activeId === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all ${
                isActive
                  ? 'bg-blue-500 text-white shadow-md'
                  : 'text-gray-600 hover:bg-white/50'
              }`}
            >
              <span className="text-base">{tab.icon}</span>
              <span className="text-xs font-medium">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
