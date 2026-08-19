import React from 'react';
import type { FeatureSection as FeatureSectionType } from '../data/features';
import { FeatureCard } from './FeatureCard';

interface FeatureSectionProps {
  section: FeatureSectionType;
}

export const FeatureSection: React.FC<FeatureSectionProps> = ({ section }) => {
  return (
    <div className="mx-6 mb-4 rounded-3xl border border-dashed border-red-300/60 p-4 bg-white/30">
      {/* 区块标题 */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-gray-900">{section.title}</h2>
            <span className="text-xl">{section.headerIcon}</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{section.subtitle}</p>
        </div>
      </div>

      {/* 功能卡片网格 2x2 */}
      <div className="grid grid-cols-2 gap-2.5">
        {section.cards.map((card) => (
          <FeatureCard key={card.title} card={card} />
        ))}
      </div>
    </div>
  );
};
