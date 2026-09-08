/**
 * 单测 dsh-web（不带 --hostname 配置）：验证 spawn + 状态序列
 * dsh 根路径返回 401，healthCheck 期望 2xx → 会 timeout（5s）→ emit timeout。
 */
import { CodingAgent } from '../electron/codingAgent';
import type { CodingAgentConfig } from '../electron/config';

const cfg: CodingAgentConfig = {
  tools: [
    {
      id: 'dsh-web',
      name: 'DSH Web',
      type: 'embedded',
      command: 'npx',
      args: ['@deepseek-ai/dsh', 'web', '--port', '<port>'],
      port: 4297,
      dirMode: 'cwd',
    },
  ],
};

async function main(): Promise<void> {
  const agent = new CodingAgent(cfg);
  agent.subscribe((s) => console.log(`[subscribe] ${JSON.stringify(s)}`));
  const tool = cfg.tools[0];
  console.log(`=== openTool: dsh-web ===`);
  const r = await agent.openTool(tool, process.cwd());
  console.log(`[RESULT] ${JSON.stringify(r)}`);
  // dsh 根路径 401 → healthCheck 5s timeout → emit timeout
  await new Promise((res) => setTimeout(res, 7000));
  console.log(`[STATUS] ${JSON.stringify(agent.getStatus())}`);
  agent.shutdown();
  await new Promise((res) => setTimeout(res, 2000));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
