import React from 'react';
import type { FeatureCard as FeatureCardType } from '../data/features';

interface FeatureCardProps {
  card: FeatureCardType;
}

export const FeatureCard: React.FC<FeatureCardProps> = ({ card }) => {
  return (
    <button
      className="flex items-center gap-3 p-3 rounded-2xl bg-white/80 hover:bg-white hover:shadow-card-hover transition-all text-left group"
    >
      <div
        className={`w-11 h-11 rounded-xl ${card.iconBg} flex items-center justify-center text-2xl flex-shrink-0`}
      >
        {card.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-gray-900">{card.title}</div>
        <div className="text-xs text-gray-500 mt-0.5 truncate">{card.desc}</div>
      </div>
    </button>
  );
};
