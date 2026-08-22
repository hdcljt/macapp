// 复刻自 macapp/src/data/features.ts
// AI 应用切换栏数据
export interface AIApp {
  id: string;
  name: string;
  icon: string; // emoji 或图标字符
  /** 圆形背景色（hex）。源 macapp 用 Tailwind class，agent-user 纯 SCSS，故改为 hex 直接绑定。 */
  bgColor: string;
}

export const aiApps: AIApp[] = [
  { id: 'qianwen', name: '千问', icon: '通', bgColor: '#3b82f6' }, // bg-blue-500
  { id: 'kimi', name: 'Kimi', icon: 'K', bgColor: '#1f2937' }, // bg-gray-800
  { id: 'zhipu', name: '智谱', icon: '智', bgColor: '#2563eb' }, // bg-blue-600
  { id: 'minimax', name: 'MiniMax', icon: 'M', bgColor: '#000000' }, // bg-black
  { id: 'keling', name: '可灵', icon: '灵', bgColor: '#a855f7' }, // bg-purple-500
  { id: 'vidu', name: 'Vidu', icon: 'V', bgColor: '#06b6d4' }, // bg-cyan-500
];

// 功能卡片数据
export interface FeatureCard {
  title: string;
  desc: string;
  icon: string; // emoji
  /** 图标容器背景（淡色，hex）。 */
  iconBg: string;
}

// 功能区块数据
export interface FeatureSection {
  id: string;
  title: string;
  subtitle: string;
  headerIcon: string; // emoji
  cards: FeatureCard[];
}

export const featureSections: FeatureSection[] = [
  {
    id: 'write',
    title: '算粒写',
    subtitle: '智能解析',
    headerIcon: '📝',
    cards: [
      {
        title: '写脑图',
        desc: '梳理知识框架',
        icon: '🧠',
        iconBg: '#d1fae5', // bg-emerald-100
      },
      {
        title: '写PPT',
        desc: '快速生成PPT',
        icon: '📊',
        iconBg: '#ffedd5', // bg-orange-100
      },
      {
        title: '写纪要',
        desc: '课堂纪要提炼',
        icon: '📋',
        iconBg: '#f3e8ff', // bg-purple-100
      },
      {
        title: '写代码',
        desc: '快速编写代码',
        icon: '💻',
        iconBg: '#dbeafe', // bg-blue-100
      },
    ],
  },
  {
    id: 'listen',
    title: '算粒听',
    subtitle: '考点音频循环听析',
    headerIcon: '🎧',
    cards: [
      {
        title: '在线听',
        desc: '音频实时转写',
        icon: '🎙️',
        iconBg: '#ffedd5', // bg-orange-100
      },
      {
        title: '离线听',
        desc: '离线音频转录',
        icon: '🔌',
        iconBg: '#dbeafe', // bg-blue-100
      },
      {
        title: '听翻译',
        desc: '实时双语转换',
        icon: '🌐',
        iconBg: '#cffafe', // bg-cyan-100
      },
      {
        title: '听音乐',
        desc: '听苹果音乐',
        icon: '🎵',
        iconBg: '#f3e8ff', // bg-purple-100
      },
    ],
  },
  {
    id: 'save',
    title: '算粒存',
    subtitle: '积攒备考点滴素材',
    headerIcon: '🍑',
    cards: [
      {
        title: '存视频',
        desc: '留存AI创作视频',
        icon: '📹',
        iconBg: '#ffedd5', // bg-orange-100
      },
      {
        title: '存笔记',
        desc: '知识点一键归档',
        icon: '📔',
        iconBg: '#dbeafe', // bg-blue-100
      },
      {
        title: '存文字',
        desc: '文稿云端备份',
        icon: '📄',
        iconBg: '#f3e8ff', // bg-purple-100
      },
      {
        title: '存图片',
        desc: 'AI图片收纳',
        icon: '🖼️',
        iconBg: '#fce7f3', // bg-pink-100
      },
    ],
  },
];

// 底部 Tab 数据
export interface BottomTab {
  id: string;
  label: string;
  icon: string; // emoji
}

export const bottomTabs: BottomTab[] = [
  { id: 'brain', label: '写脑图', icon: '🧠' },
  { id: 'listen', label: '在线听', icon: '🎙️' },
  { id: 'video', label: '存视频', icon: '📹' },
  { id: 'code', label: '写代码', icon: '💻' },
];

// mock agent 列表（离线场景替代真实 API）
export interface MockAgent {
  name: string;
  icon: string;
  desc: string;
}

export const mockAgents: { public: MockAgent[]; private: MockAgent[] } = {
  public: [
    { name: '写邮件助手', icon: '✉️', desc: '一键生成专业邮件' },
    { name: '代码评审', icon: '🔍', desc: '智能分析代码质量' },
    { name: '翻译官', icon: '🌐', desc: '多语言互译' },
    { name: '会议纪要', icon: '📝', desc: '自动整理会议要点' },
  ],
  // 离线模式无登录态，私域始终为空数组。
  private: [],
};