import { spawn, execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
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
 * Windows 上 spawn(shell:false) 不解析 PATHEXT，npm 包的 .cmd shim（如 npx.cmd）找不到。
 * 依次返回候选命令名：[cmd, cmd.cmd, cmd.bat, cmd.exe]，调用方逐个 spawn，
 * 用第一个不抛同步错误的 child。
 * 注意：ENOENT 是异步的（'error' 事件），同步 spawn 一般不抛，所以异步 ENOENT
 * 仍需由 child.on('error') 兜底上报 spawn-failed。
 * 非 Windows 直接返回 [cmd]。
 */
function resolveSpawnCommand(cmd: string): string[] {
  if (process.platform !== 'win32') return [cmd];
  return [cmd, `${cmd}.cmd`, `${cmd}.bat`, `${cmd}.exe`];
}

/**
 * 按候选命令依次 spawn，返回第一个不抛同步错误的 child；全失败则返回最后的错误。
 */
function spawnWithCandidates(
  cmd: string,
  args: string[],
  options: SpawnOptions,
): { child: ChildProcess } | { child: null; error: Error | null } {
  let lastSyncError: Error | null = null;
  for (const candidate of resolveSpawnCommand(cmd)) {
    try {
      return { child: spawn(candidate, args, options) };
    } catch (err) {
      lastSyncError = err as Error;
    }
  }
  return { child: null, error: lastSyncError };
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
   * - url → 直接返回 ok+url（不 spawn、不发状态；由 main 进程调 showCodingView loadURL）
   */
  async openTool(tool: CodingTool, dir: string): Promise<CodingOpenResult> {
    if (tool.type === 'external') return this.spawnExternal(tool, dir);
    if (tool.type === 'url') {
      log.info(`open url tool: ${tool.url}`);
      return { ok: true, url: tool.url };
    }
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

    const spawned = spawnWithCandidates(cmd, args, {
      detached: true, stdio: 'ignore', cwd, shell: false,
    });
    if (!spawned.child) {
      const message = spawned.error?.message ?? `spawn ${cmd} failed`;
      log.error(`external spawn threw: ${message}`);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }
    const child = spawned.child;

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
   *
   * 切换语义：openTool 检测到已有 child 时自动 shutdown 老的再启新的，
   *   而不是拒绝（用户切工具是正常行为）。shutdown 是异步的，await 不阻塞 spawn。
   */
  private async spawnEmbedded(tool: EmbeddedTool, dir: string): Promise<CodingOpenResult> {
    // 切换：自动 shutdown 老的 child。shutdown() 内 SIGTERM + 2s SIGKILL fallback，
    // child.on('exit') 会异步清空 this.child。spawn 用新 port（pickPort 跳过占用）。
    if (this.child && !this.child.killed) {
      log.info(`switching embedded tool: shutdown previous child first`);
      // 移除老 child 的 'exit' listener：否则老 child 被 taskkill /f /t 杀（exit code=1）
      //   会异步触发 listener → emit { state: 'exited' } → UI 弹"工具已退出"toast（用户报告）。
      //   主动 shutdown 的 exit 是预期行为，不是异常退出，不应该让 UI 看到。
      // stderrBuf 残余随 listener 一起丢失，但 spawn 阶段已 flush 过 4KB 缓冲，
      //   主动 shutdown 时残余一般 < 4KB，可接受。
      this.child.removeAllListeners('exit');
      this.shutdown();
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

    // 关键：embedded 命令通常是 'npx'，在 Windows 上是 npx.cmd shim。
    // Node.js spawn 默认不解析 PATHEXT，必须 cmd.exe 中介才能跑 .cmd。
    // 不能用 spawn shell:true —— shell:true 在 Windows 上把 stdio pipe "提升"给 cmd.exe 自己，
    //   cmd.exe 起的 npx.cmd → node → dsh 子进程 inherit cmd.exe 的 console handle，
    //   子进程 stdout 写到 console（弹黑窗），不走我们的 pipe。
    // 解法：显式 spawn 'cmd.exe' + '/c' + 命令，shell:false 让 cmd.exe 的 stdio 真正是 pipe，
    //   子进程 inherit pipe handle → stdout 走 pipe 不弹窗。
    // Windows 注意：必须 detached:false —— Node.js 文档明确说「detached:true makes the
    //   child have its own console window. Once enabled, it cannot be disabled」，
    //   即使配 windowsHide + creationFlags 也无法关闭。Unix 必须 detached:true 配合
    //   process.kill(-pid) 才能杀整个进程组；Windows 走 taskkill /f /t（不依赖 detached）。
    const isWin = process.platform === 'win32';
    type SpawnResult = { child: ChildProcess } | { child: null; error: Error | null };
    const wrapSpawn = (fn: () => ChildProcess): SpawnResult => {
      try {
        return { child: fn() };
      } catch (err) {
        return { child: null, error: err as Error };
      }
    };
    const spawned: SpawnResult = isWin
      ? wrapSpawn(() =>
          spawn('cmd.exe', ['/c', tool.command, ...args], {
            detached: false, // detached:true 在 Windows 上强制开 console window，windowsHide 关不掉
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd,
            env: { ...process.env, PORT: String(port) },
            shell: false,
            windowsHide: true,
          }),
        )
      : spawnWithCandidates(tool.command, args, {
          detached: true, // Unix: child 进入新 session，shutdown() 用 process.kill(-pid) 杀整个 group
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd,
          env: { ...process.env, PORT: String(port) },
          shell: false,
        });
    if (!spawned.child) {
      const message = spawned.error?.message ?? `spawn ${tool.command} failed`;
      log.error(`embedded spawn threw: ${message}`);
      this.emit({ state: 'spawn-failed', message });
      return { ok: false, reason: 'spawn-failed', message };
    }
    const child = spawned.child;

    this.child = child;

    // spawn 找不到命令时 Node 不 throw 而是异步 emit 'error'；无监听者会变成
    // uncaughtException（Electron 主进程弹错框），这里兜底转成 spawn-failed 状态。
    let spawnError: Error | null = null;
    child.on('error', (err) => {
      log.warn(`embedded spawn error: ${err.message}`);
      spawnError = err;
      this.child = null;
      this.emit({ state: 'spawn-failed', message: err.message });
    });

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

    // stdout 解析 token URL：dsh web 启动时输出 `dsh web: http://...?token=xxx`，
    // 根路径访问会 401，必须用带 token 的 URL；opencode 等不带 token 的工具不会匹配，
    // ready 时 fallback 到默认 port URL。
    // 用首个匹配即可（同一个进程多次写同样 URL 会取第一次稳定的）。
    let tokenUrl: string | null = null;
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (tokenUrl) return; // 已经拿到就不重复 parse
      const match = text.match(/https?:\/\/[^\s]+/);
      if (match) {
        tokenUrl = match[0];
        log.debug(`[${tool.id} stdout] detected URL: ${tokenUrl}`);
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
      // 注意：this.child 可能已经被 shutdown() 置 null（用户切工具主动杀）或被新 spawn 替换，
      //   此时这个老 child 的 exit 是"主动结束"不是"异常退出"，不 emit exited 避免 UI 弹
      //   "工具已退出" 噪音 toast。this.child === child 才是真正的"运行中 child 异常退出"。
      if (this.child !== child) {
        log.debug(`ignore exit of replaced child (active child differs)`);
        return;
      }
      this.child = null;
      if (code === 0 || code === null) {
        this.emit({ state: 'idle' });
      } else {
        this.emit({ state: 'exited', code: code ?? -1, toolId: toolIdAtSpawn });
      }
    });

    const ready = await this.healthCheck(port, 5000);
    if (!ready) {
      // spawn 已异步失败（如 ENOENT）：spawn-failed 已 emit，不要再覆盖成 timeout
      if (spawnError) {
        const message = (spawnError as Error).message;
        return { ok: false, reason: 'spawn-failed', message };
      }
      log.error(`health check timeout: port=${port}`);
      this.child?.kill('SIGTERM');
      this.emit({ state: 'timeout' });
      // 不 setImmediate emit idle：kill('SIGTERM') 会触发上面的 child.on('exit')，
      // 由 exit listener 异步 emit idle/exited，避免重复 emit 造成状态机 race
      return { ok: false, reason: 'timeout', message: '工具启动超时（5s 未就绪）' };
    }

    // healthCheck 通过后，给 tokenUrl 解析 500ms 缓冲窗口：
    // dsh web 启动后 stdout 输出 `dsh web: http://...?token=xxx`，但 child.stdout
    // 'data' 事件可能在 healthCheck 通过后才异步触发（实测 ready 23ms 后才到），
    // 此时必须等 token URL 出现，否则 ready.url 用默认 port URL → codingView 加载 404。
    // opencode 等不带 token 的工具不会匹配 regex，500ms 后 tokenUrl 仍为 null，fallback 默认 URL。
    if (!tokenUrl) {
      await new Promise((r) => setTimeout(r, 500));
    }

    const url = tokenUrl ?? `http://127.0.0.1:${port}`;
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
        // 接受任何 < 500 的状态码：
        // - 200: 工具正常（如 opencode web）
        // - 401/403: 工具需要鉴权（dsh web 根路径返回 401，但带了 token URL 是好的）
        // - 302/3xx: 重定向（部分 SPA 工具）
        // - 5xx: 服务异常，不算 ready
        if (res.status < 500) return true;
      } catch { /* 连接拒绝/超时，继续轮询 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  /**
   * 关闭当前 embedded 子进程
   * - external 已 unref，不需要处理
   * - Windows 上 child 是 cmd.exe（shell:true 启动 npx.cmd → node → dsh/opencode 二进制），
   *   child.kill('SIGTERM') 只杀 cmd.exe 一层，npx/node/dsh 还活着，端口继续被占。
   *   用 `taskkill /f /t` 杀整个进程树：/t = tree，/f = force，
   *   execFileSync 同步等待 taskkill 跑完（before-quit 触发时主进程马上要退，
   *   spawn 的异步 taskkill 会被 Node 提前终止导致树杀不干净）。
   * - Unix 上没有等价的 taskkill，直接 SIGTERM 整个进程组：
   *   spawn 时已 detached: true + setsid，process.kill(-pid) 杀整个 group。
   *   2s 后兜底 SIGKILL（兜底 setTimeout unref 不阻止 Node 退出）。
   * - 立即清空 this.child：避免 before-quit 异步阶段 + child.on('exit') race 双重 emit。
   */
  shutdown(): void {
    if (!this.child || this.child.killed) return;
    const child = this.child;
    const pid = child.pid;
    log.info(`shutdown: killing embedded child tree pid=${pid}`);
    this.child = null; // 立即清空，避免退出 race
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        // taskkill 在目标进程已退出时返回非 0 exit code（按设计），忽略
      }
      return;
    }
    try { process.kill(-pid!, 'SIGTERM'); } catch { /* group kill 可能 ESRCH */ }
    setTimeout(() => {
      try { process.kill(-pid!, 'SIGKILL'); } catch { /* 已退 */ }
    }, 2000).unref();
  }
}
