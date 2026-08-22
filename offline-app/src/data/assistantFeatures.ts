// AI 应用切换数据
export interface AIApp {
  id: string;
  name: string;
  icon: string;
  /** 图标背景色（hex 值，避免引入 Tailwind） */
  bgColor: string;
}

export const aiApps: AIApp[] = [
  { id: 'qianwen', name: '千问', icon: '通', bgColor: '#3b82f6' },
  { id: 'kimi', name: 'Kimi', icon: 'K', bgColor: '#1f2937' },
  { id: 'zhipu', name: '智谱', icon: '智', bgColor: '#2563eb' },
  { id: 'minimax', name: 'MiniMax', icon: 'M', bgColor: '#000000' },
  { id: 'keling', name: '可灵', icon: '灵', bgColor: '#a855f7' },
  { id: 'vidu', name: 'Vidu', icon: 'V', bgColor: '#06b6d4' },
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
  cards: FeatureCard[];
}

export const featureSections: FeatureSection[] = [
  {
    id: 'write',
    title: '算粒写',
    subtitle: 'AI 帮你高效创作',
    headerIcon: '✍️',
    cards: [
      { title: '周报生成', desc: '一键生成工作周报', icon: '📊', iconBg: '#FEF3C7', iconColor: '#D97706' },
      { title: '邮件撰写', desc: '专业得体的邮件', icon: '✉️', iconBg: '#DBEAFE', iconColor: '#2563EB' },
      { title: '文案润色', desc: '让文字更有感染力', icon: '✨', iconBg: '#FCE7F3', iconColor: '#DB2777' },
      { title: '翻译', desc: '多语言精准互译', icon: '🌐', iconBg: '#D1FAE5', iconColor: '#059669' },
    ],
  },
  {
    id: 'listen',
    title: '算粒听',
    subtitle: 'AI 语音交互',
    headerIcon: '🎙️',
    cards: [
      { title: '语音输入', desc: '按住说话，秒变文字', icon: '🎤', iconBg: '#FEE2E2', iconColor: '#DC2626' },
      { title: '会议记录', desc: '自动整理会议要点', icon: '📝', iconBg: '#E0E7FF', iconColor: '#4F46E5' },
      { title: '语音翻译', desc: '说中文，出英文', icon: '🗣️', iconBg: '#FEF3C7', iconColor: '#D97706' },
      { title: '语音克隆', desc: '定制专属 AI 音色', icon: '🎭', iconBg: '#FCE7F3', iconColor: '#DB2777' },
    ],
  },
  {
    id: 'store',
    title: '算粒存',
    subtitle: 'AI 知识管理',
    headerIcon: '📚',
    cards: [
      { title: '笔记摘要', desc: '长文一键提炼要点', icon: '📋', iconBg: '#D1FAE5', iconColor: '#059669' },
      { title: '问答库', desc: '个人专属知识库', icon: '💡', iconBg: '#FEF3C7', iconColor: '#D97706' },
      { title: '文件搜索', desc: '自然语言找文件', icon: '🔍', iconBg: '#DBEAFE', iconColor: '#2563EB' },
      { title: '日程规划', desc: 'AI 帮你安排一天', icon: '📅', iconBg: '#FCE7F3', iconColor: '#DB2777' },
    ],
  },
];

// 底部 Tab 数据
export interface BottomTab {
  id: string;
  name: string;
  icon: string;
}

export const bottomTabs: BottomTab[] = [
  { id: 'home', name: '首页', icon: '🏠' },
  { id: 'discover', name: '发现', icon: '🔍' },
  { id: 'workspace', name: '工作台', icon: '💼' },
  { id: 'me', name: '我的', icon: '👤' },
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
