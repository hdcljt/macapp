import React from 'react';
import { isMac } from '../utils/platform';

export const TopBar: React.FC = () => {
  return (
    <header
      className="drag-region relative h-14 flex items-center justify-between px-6 bg-transparent"
      style={{ paddingLeft: isMac() ? '78px' : '24px' }}
    >
      {/* 左侧菜单按钮 */}
      <button
        className="no-drag w-9 h-9 flex items-center justify-center rounded-lg hover:bg-white/40 transition-colors"
        aria-label="菜单"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* 右侧操作按钮 */}
      <div className="no-drag flex items-center gap-2">
        <button
          className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-white/40 transition-colors"
          aria-label="新建对话"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <line x1="12" y1="8" x2="12" y2="14" />
            <line x1="9" y1="11" x2="15" y2="11" />
          </svg>
        </button>
      </div>
    </header>
  );
};
