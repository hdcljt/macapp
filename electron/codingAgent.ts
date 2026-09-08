import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { logger } from './logger';
import type { CodingTool, CodingAgentConfig, ExternalTool, EmbeddedTool } from './config';

const log = logger.child('coding');

/**
 * CodingAgent 状态机
 * - idle: 无活动进程
 * - launching-external: 外部 IDE 已 spawn，等待 OS 接管
 * - spawning-embedded: 内嵌 web 已 spawn，等待 health check
 * - ready-embedded: 内嵌 web health check 通过
 * - spawn-failed: spawn 抛错或异步 'error' 事件
 * - timeout: health check 5s 未就绪
 * - exited: 内嵌进程非零退出
 */
export type CodingStatus =
  | { state: 'idle' }
  | { state: 'launching-external'; toolId: string }
  | { state: 'spawning-embedded'; toolId: string }
  | { state: 'ready-embedded'; url: string; toolId: string }
  | { state: 'spawn-failed'; message: string }
  | { state: 'timeout' }
  | { state: 'exited'; code: number; toolId: string };

/**
 * openTool 返回结果（dialog 层自己处理 'unknown-tool'）
 * - ok: true  → 调用方应进入对应视图（external 切回 idle；embedded 加载 url）
 * - ok: false → spawn 失败 / 超时
 */
export type CodingOpenResult =
  | { ok: true; url?: string }
  | { ok: false; reason: 'unknown-tool' | 'spawn-failed' | 'timeout'; message: string };

/**
 * 探测端口是否空闲（127.0.0.1）
 * - 监听成功 → 立刻关闭 → 返回 true
 * - EADDRINUSE → 返回 false
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 从 preferred 起探测 5 个端口，返回第一个空闲的；全占 → null
 */
async function pickPort(preferred: number): Promise<number | null> {
  for (let p = preferred; p < preferred + 5; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

/**
 * 构造 embedded spawn 参数：
 * - template 里 '<port>' 替换为实际 port
 * - dirMode === 'positional' 时把 dir 追加到末尾
 * - dirMode === 'cwd' 时由调用方设置 options.cwd
 * - dirMode === 'none' 时既不追加也不设 cwd
 */
function buildArgs(template: string[], dir: string, dirMode: 'positional' | 'cwd' | 'none', port: number): string[] {
  const result = template.map((arg) => arg === '<port>' ? String(port) : arg);
  if (dirMode === 'positional') result.push(dir);
  return result;
}

/**
 * 构造 external spawn 参数（无 <port> 替换）
 * - dirMode === 'positional' 时把 dir 追加到末尾
 * - dirMode === 'cwd' 时由调用方设置 options.cwd
 * - dirMode === 'none' 时既不追加也不设 cwd
 */
function buildExternalArgs(
  template: string[],
  dir: string,
  dirMode: 'positional' | 'cwd' | 'none',
): string[] {
  const result = [...template];
  if (dirMode === 'positional') result.push(dir);
  return result;
}

/**
 * 编码工具进程管理器（external + embedded）
 * - 单一活动进程：external 不持有 child（detached + unref），embedded 持有 child 引用
 * - 状态机通过 emit() 通知订阅者；调用方可在 openTool 返回后立刻 getStatus() 拿到最新快照
 */
export class CodingAgent {
  private status: CodingStatus = { state: 'idle' };
  private child: ChildProcess | null = null;
  private listeners = new Set<(s: CodingStatus) => void>();

  constructor(private cfg: CodingAgentConfig) {}

  /** 订阅状态变化；返回 unsubscribe */
  subscribe(cb: (s: CodingStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 同步获取当前状态 */
  getStatus(): CodingStatus { return this.status; }

  /** renderer 启动时拿初始状态（promise 形式与 ui store 对齐） */
  getInitialStatus(): Promise<CodingStatus> { return Promise.resolve(this.status); }

  private emit(next: CodingStatus): void {
    this.status = next;
    log.debug(`status: ${JSON.stringify(next)}`);
    for (const cb of this.listeners) {
      try { cb(next); } catch (err) { log.warn(`subscriber error: ${(err as Error).message}`); }
    }
  }

  /**
   * 打开工具入口
   * - external → spawnExternal
   * - embedded → spawnEmbedded
   */
  async openTool(tool: CodingTool, dir: string): Promise<CodingOpenResult> {
    if (tool.type === 'external') return this.spawnExternal(tool, dir);
    return this.spawnEmbedded(tool, dir);
  }

  /**
   * external：spawn detached + stdio:ignore + shell:false
   * 修原版本 bug：detached + 异步 'error' 事件可能晚于 return，导致 UI 已切回 idle 但 spawn-failed 来不及上报
   * 修法：返回前用 child.on('spawn') / 'error' 任一抢先 resolved 决定 emit 什么；
   *   若 return 时都没触发，则等 'spawn' 成功后才 emit launching-external；
   *   若 'error' 异步触发且还没 resolved → emit spawn-failed。
   * launching-external 持续到下次 openTool 或 app 退出，不再 setImmediate 回 idle。
   */
  private spawnExternal(tool: ExternalTool, dir: string): CodingOpenResult {
    // 存量检测：embedded 在跑时打开 external 会让状态机与实际进程不一致，直接拒绝
    if (this.child && !this.child.killed) {
      const message = '已有内嵌工具在运行，请先关闭';
      log.warn(message);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }

    const args = buildExternalArgs(tool.args ?? [], dir, tool.dirMode);

    const cmd = tool.path && tool.path.length > 0 ? tool.path : tool.command;
    const cwd = tool.dirMode === 'cwd' ? dir : process.cwd();

    log.info(`spawn external: ${cmd} ${args.join(' ')} (cwd=${cwd})`);

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        detached: true, stdio: 'ignore', cwd, shell: false,
      });
    } catch (err) {
      const message = (err as Error).message;
      log.error(`external spawn threw: ${message}`);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }

    let resolved = false;
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      log.warn(`external spawn error: ${err.message}`);
      this.emit({ state: 'spawn-failed', message: err.message });
    });
    child.on('spawn', () => {
      if (resolved) return;
      resolved = true;
      child.unref();
      this.emit({ state: 'launching-external', toolId: tool.id });
      // 不自动回 idle：launching-external 持续到下次 openTool 或 app 退出
    });

    return { ok: true };
  }

  /**
   * embedded：pickPort → spawn + PORT env + pipe stdio → emit spawning-embedded
   *   → child.on('exit')（code=0 回 idle；code≠0 上报 exited）
   *   → healthCheck 5s → ready-embedded / timeout
   * 注意：spawn 与 health check 串行；中途 'exit' 触发会清空 child，
   *   health check 失败时主动 kill 防止僵尸进程。
   */
  private async spawnEmbedded(tool: EmbeddedTool, dir: string): Promise<CodingOpenResult> {
    // 二次调用检测：embedded 模式单一活动进程，已有 child 在跑则拒绝
    if (this.child && !this.child.killed) {
      const message = '已有内嵌工具在运行，请先关闭';
      log.warn(message);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }

    const port = await pickPort(tool.port);
    if (port === null) {
      const message = `端口 ${tool.port}~${tool.port + 4} 全部被占`;
      log.error(message);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }

    const args = buildArgs(tool.args, dir, tool.dirMode, port);
    const cwd = tool.dirMode === 'cwd' ? dir : process.cwd();

    log.info(`spawn embedded: ${tool.command} ${args.join(' ')} (port=${port}, cwd=${cwd})`);

    let child: ChildProcess;
    try {
      child = spawn(tool.command, args, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env, PORT: String(port) },
      });
    } catch (err) {
      const message = (err as Error).message;
      log.error(`embedded spawn threw: ${message}`);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }

    this.child = child;

    // stderr 累计 buffer：避免 per-chunk slice 丢日志；满 4KB 整段打印并清空
    let stderrBuf = '';
    const STDERR_BUF_MAX = 4 * 1024;
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length >= STDERR_BUF_MAX) {
        log.warn(`[${tool.id} stderr] ${stderrBuf}`);
        stderrBuf = '';
      }
    });

    this.emit({ state: 'spawning-embedded', toolId: tool.id });

    // 用 closure 捕获 spawn 时的 toolId，避免后续 openTool 覆盖导致 exited event toolId 错误
    const toolIdAtSpawn = tool.id;
    child.on('exit', (code, signal) => {
      // flush 未满 4KB 的残余 stderr，避免退出时丢诊断信息
      if (stderrBuf.length > 0) {
        log.warn(`[${toolIdAtSpawn} stderr] ${stderrBuf}`);
        stderrBuf = '';
      }
      log.info(`embedded exit: code=${code} signal=${signal}`);
      this.child = null;
      if (code === 0 || code === null) {
        this.emit({ state: 'idle' });
      } else {
        this.emit({ state: 'exited', code: code ?? -1, toolId: toolIdAtSpawn });
      }
    });

    const ready = await this.healthCheck(port, 5000);
    if (!ready) {
      log.error(`health check timeout: port=${port}`);
      this.child?.kill('SIGTERM');
      this.emit({ state: 'timeout' });
      // 不 setImmediate emit idle：kill('SIGTERM') 会触发上面的 child.on('exit')，
      // 由 exit listener 异步 emit idle/exited，避免重复 emit 造成状态机 race
      return { ok: false, reason: 'timeout', message: '工具启动超时（5s 未就绪）' };
    }

    const url = `http://127.0.0.1:${port}`;
    log.info(`embedded ready: ${url}`);
    this.emit({ state: 'ready-embedded', url, toolId: tool.id });
    return { ok: true, url };
  }

  /**
   * 轮询探测 127.0.0.1:<port>/ 是否返回 2xx
   * - 200ms 间隔
   * - 每次 fetch 1s timeout（用 AbortSignal.timeout）
   * - 任一次 2xx → true；截止前都没成功 → false
   */
  private async healthCheck(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch { /* 连接拒绝/超时，继续轮询 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  /**
   * 关闭当前 embedded 子进程
   * - external 已 unref，不需要处理
   * - SIGTERM 后用 setTimeout 兜底 2s SIGKILL（异步，不阻塞主线程）
   * - 判活用 exitCode/signalCode 均为 null（child.killed 只表示信号已发出，SIGTERM 后立刻为 true）
   * - child.once('exit') 清理 timeout，避免对已退出进程做无意义的 SIGKILL
   * - setTimeout.unref() 不阻止进程退出
   */
  shutdown(): void {
    if (!this.child || this.child.killed) return;
    const child = this.child;
    log.info('shutdown: killing embedded child');
    const fallback = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log.warn('shutdown: SIGTERM timeout, sending SIGKILL');
        child.kill('SIGKILL');
      }
    }, 2000);
    fallback.unref();
    child.once('exit', () => clearTimeout(fallback));
    child.kill('SIGTERM');
  }
}
