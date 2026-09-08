/**
 * CodingAgent 端到端测试：跑真实的 openTool 流程，看 status 序列 + 验证 ready.url 可访问。
 *
 * 三个 tool 都跑：external + 两个 embedded（opencode-web / dsh-web），每个之间 shutdown。
 * 验证项：
 *   1. status 序列包含 spawning-embedded → ready-embedded
 *   2. result.ok === true 且 result.url 非空
 *   3. 对 ready.url 真正 fetch 一次：opencode 应 200，dsh 带 token 应 200
 *
 * 跑法：
 *   npx esbuild scripts/e2e-coding.ts --bundle --platform=node --target=node18 \
 *     --alias:electron=./scripts/e2e-electron-stub.js --outfile=dist-electron/e2e-coding.js
 *   node dist-electron/e2e-coding.js
 */
import { CodingAgent } from '../electron/codingAgent';
import type { CodingAgentConfig } from '../electron/config';

const cfg: CodingAgentConfig = {
  tools: [
    {
      id: 'codebuddy',
      name: 'CodeBuddy',
      type: 'external',
      command: 'D:\\hudc\\AppData\\CodeBuddy CN\\CodeBuddy CN.exe',
      args: [],
      dirMode: 'positional',
    },
    {
      id: 'opencode-web',
      name: 'OpenCode Web',
      type: 'embedded',
      command: 'npx',
      args: ['opencode-ai', 'web', '--port', '<port>', '--hostname', '127.0.0.1'],
      port: 4296,
      dirMode: 'cwd',
    },
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function probe(url: string): Promise<{ status: number; len: number; head: string } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const text = await r.text();
    return { status: r.status, len: text.length, head: text.slice(0, 80) };
  } catch {
    return null;
  }
}

const failures: string[] = [];

async function runExternal(): Promise<void> {
  console.log('\n=== external: CodeBuddy ===');
  const agent = new CodingAgent({ tools: [cfg.tools[0]] });
  const tool = cfg.tools[0];
  const r = await agent.openTool(tool, process.cwd());
  console.log(`[RESULT] ${JSON.stringify(r)}`);
  if (r.ok !== true) failures.push(`external: result.ok !== true (${JSON.stringify(r)})`);
  // status 应是 launching-external
  const s = agent.getStatus();
  if (s.state !== 'launching-external') failures.push(`external: status not launching-external (${JSON.stringify(s)})`);
  else console.log(`✓ external launching-external`);
  agent.shutdown();
  await delay(1500);
}

async function runEmbedded(toolId: string, expectedProbeStatus: number): Promise<void> {
  console.log(`\n=== embedded: ${toolId} ===`);
  const agent = new CodingAgent({ tools: cfg.tools });
  const tool = cfg.tools.find((t) => t.id === toolId)!;

  const statusTrace: string[] = [];
  agent.subscribe((s) => statusTrace.push(s.state));

  const r = await agent.openTool(tool, process.cwd());
  console.log(`[RESULT] ${JSON.stringify(r)}`);

  if (r.ok !== true) {
    failures.push(`${toolId}: result.ok !== true (${JSON.stringify(r)})`);
    return;
  }
  if (!r.url) {
    failures.push(`${toolId}: result.url missing`);
    return;
  }

  console.log(`✓ ${toolId} ready-embedded url=${r.url}`);

  // 状态序列必须包含 spawning-embedded → ready-embedded
  if (!statusTrace.includes('spawning-embedded')) failures.push(`${toolId}: no spawning-embedded in trace ${JSON.stringify(statusTrace)}`);
  if (!statusTrace.includes('ready-embedded')) failures.push(`${toolId}: no ready-embedded in trace ${JSON.stringify(statusTrace)}`);

  // 真的 fetch ready.url 验证
  const probeResult = await probe(r.url);
  if (!probeResult) {
    failures.push(`${toolId}: ready.url fetch failed`);
  } else {
    console.log(`✓ ${toolId} GET ${r.url} → ${probeResult.status} (${probeResult.len} bytes)`);
    if (probeResult.status !== expectedProbeStatus) {
      failures.push(`${toolId}: expected probe ${expectedProbeStatus}, got ${probeResult.status}`);
    }
  }

  agent.shutdown();
  await delay(2500);
  const after = agent.getStatus();
  if (after.state !== 'idle') failures.push(`${toolId}: shutdown not idle (${JSON.stringify(after)})`);
  else console.log(`✓ ${toolId} shutdown → idle`);
}

async function main(): Promise<void> {
  await runExternal();
  await runEmbedded('opencode-web', 200); // opencode web 根路径 200
  await runEmbedded('dsh-web', 200);      // dsh web 带 token 200
  console.log('\n=== summary ===');
  if (failures.length > 0) {
    console.error(`✗ ${failures.length} FAILURES:`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  } else {
    console.log('✓ ALL TESTS PASSED');
    process.exit(0);
  }
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
