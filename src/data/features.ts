// AI 应用切换数据
export interface AIApp {
  id: string;
  name: string;
  icon: string; // emoji 或图标字符
  bgColor: string;
  active?: boolean;
}

export const aiApps: AIApp[] = [
  { id: 'qianwen', name: '千问', icon: '通', bgColor: 'bg-blue-500' },
  { id: 'kimi', name: 'Kimi', icon: 'K', bgColor: 'bg-gray-800' },
  { id: 'zhipu', name: '智谱', icon: '智', bgColor: 'bg-blue-600' },
  { id: 'minimax', name: 'MiniMax', icon: 'M', bgColor: 'bg-black' },
  { id: 'keling', name: '可灵', icon: '灵', bgColor: 'bg-purple-500' },
  { id: 'vidu', name: 'Vidu', icon: 'V', bgColor: 'bg-cyan-500' },
];

// 功能卡片数据
export interface FeatureCard {
  title: string;
  desc: string;
  icon: string;
  iconBg: string;
  iconColor: string;
}

export interface FeatureSection {
  id: string;
  title: string;
  subtitle: string;
  headerIcon: string;
  headerColor: string;
  cards: FeatureCard[];
}

export const featureSections: FeatureSection[] = [
  {
    id: 'write',
    title: '算粒写',
    subtitle: '智能解析',
    headerIcon: '📝',
    headerColor: 'from-blue-100 to-purple-100',
    cards: [
      {
        title: '写脑图',
        desc: '梳理知识框架',
        icon: '🧠',
        iconBg: 'bg-emerald-100',
        iconColor: 'text-emerald-600',
      },
      {
        title: '写PPT',
        desc: '快速生成PPT',
        icon: '📊',
        iconBg: 'bg-orange-100',
        iconColor: 'text-orange-600',
      },
      {
        title: '写纪要',
        desc: '课堂纪要提炼',
        icon: '📋',
        iconBg: 'bg-purple-100',
        iconColor: 'text-purple-600',
      },
      {
        title: '写代码',
        desc: '快速编写代码',
        icon: '💻',
        iconBg: 'bg-blue-100',
        iconColor: 'text-blue-600',
      },
    ],
  },
  {
    id: 'listen',
    title: '算粒听',
    subtitle: '考点音频循环听析',
    headerIcon: '🎧',
    headerColor: 'from-purple-100 to-pink-100',
    cards: [
      {
        title: '在线听',
        desc: '音频实时转写',
        icon: '🎙️',
        iconBg: 'bg-orange-100',
        iconColor: 'text-orange-600',
      },
      {
        title: '离线听',
        desc: '离线音频转录',
        icon: '🔌',
        iconBg: 'bg-blue-100',
        iconColor: 'text-blue-600',
      },
      {
        title: '听翻译',
        desc: '实时双语转换',
        icon: '🌐',
        iconBg: 'bg-cyan-100',
        iconColor: 'text-cyan-600',
      },
      {
        title: '听音乐',
        desc: '听苹果音乐',
        icon: '🎵',
        iconBg: 'bg-purple-100',
        iconColor: 'text-purple-600',
      },
    ],
  },
  {
    id: 'save',
    title: '算粒存',
    subtitle: '积攒备考点滴素材',
    headerIcon: '🍑',
    headerColor: 'from-pink-100 to-orange-100',
    cards: [
      {
        title: '存视频',
        desc: '留存AI创作视频',
        icon: '📹',
        iconBg: 'bg-orange-100',
        iconColor: 'text-orange-600',
      },
      {
        title: '存笔记',
        desc: '知识点一键归档',
        icon: '📔',
        iconBg: 'bg-blue-100',
        iconColor: 'text-blue-600',
      },
      {
        title: '存文字',
        desc: '文稿云端备份',
        icon: '📄',
        iconBg: 'bg-purple-100',
        iconColor: 'text-purple-600',
      },
      {
        title: '存图片',
        desc: 'AI图片收纳',
        icon: '🖼️',
        iconBg: 'bg-pink-100',
        iconColor: 'text-pink-600',
      },
    ],
  },
];

// 底部 Tab 数据
export interface BottomTab {
  id: string;
  label: string;
  icon: string;
}

export const bottomTabs: BottomTab[] = [
  { id: 'brain', label: '写脑图', icon: '🧠' },
  { id: 'listen', label: '在线听', icon: '🎙️' },
  { id: 'video', label: '存视频', icon: '📹' },
  { id: 'code', label: '写代码', icon: '💻' },
];
