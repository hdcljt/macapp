import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, modify, applyEdits, ParseError } from 'jsonc-parser';
import { logger } from './logger';

const log = logger.child('config');

/** 更新通道：stable（仅正式版）/ beta（含预发布 rc / beta 版本） */
export type UpdateChannel = 'stable' | 'beta';

/**
 * 编码工具基础字段
 */
export interface CodingToolBase {
  /** 工具唯一 id；dialog 内部用，UI 不展示 */
  id: string;
  /** 显示名（dialog + toast） */
  name: string;
  /** 可选描述（dialog tooltip） */
  description?: string;
}

/** 外部编码工具：spawn detached，外部 IDE 接管 */
export interface ExternalTool extends CodingToolBase {
  type: 'external';
  /** 命令名（如 'opencode' / 'cursor'） */
  command: string;
  /** 完整可执行路径；非空时跳过 PATH 探测 */
  path?: string;
  /** 命令参数；external 模式直接 spawn 透传（不替换占位符） */
  args?: string[];
  /** 目录怎么传给命令 */
  dirMode: 'positional' | 'cwd' | 'none';
}

/** 内嵌编码工具：spawn 内嵌 web 服务，主进程加载到 codingView */
export interface EmbeddedTool extends CodingToolBase {
  type: 'embedded';
  /** 命令（通常是 'npx'） */
  command: string;
  /** 命令参数；占位符 '<port>' spawn 时替换为实际端口 */
  args: string[];
  /** 内嵌 web 监听端口；占用时自动探测 port+1 ~ port+4 */
  port: number;
  /** 目录怎么传给命令；embedded 不支持 'none' */
  dirMode: 'positional' | 'cwd';
}

/** URL 链接工具：直接把 url 加载到 codingView（不 spawn、不端口探测） */
export interface UrlTool extends CodingToolBase {
  type: 'url';
  /** 要加载的 url（http/https；校验通过 new URL() + 协议头） */
  url: string;
}

/** 编码工具（外部 IDE / 内嵌 Web / URL 链接） */
export type CodingTool = ExternalTool | EmbeddedTool | UrlTool;

/** 编码工具配置 */
export interface CodingAgentConfig {
  /** 编码工具列表（external IDE + embedded Web） */
  tools: CodingTool[];
}

/**
 * 应用配置 schema（12 字段，全部必填）
 *
 * 视图策略由 `useOfflineFallback` 字段控制：
 * - true（v0.6.0+ 默认）：offline-first，app 启动直接显示离线页，URL 异步加载
 * - false：splash → retry → error 旧流程，contentView 失败时重试 N 次后切到错误页
 *
 * 编码工具列表由 `codingAgent` 字段控制（v1.2 新增）：
 * - 每次点「写代码」会弹 dialog 列出这些工具，用户选一个后弹目录选择 dialog
 * - type: external ─► spawn detached，外部 IDE 接管
 * - type: embedded ─► spawn 内嵌 web 服务，主进程加载到 codingView
 */
export interface AppConfig {
  /** 目标 URL（Agent 用户助手入口），仅接受 http:// 与 https:// */
  targetUrl: string;
  /** 最大重试次数（≥ 0 整数） */
  maxRetries: number;
  /** 每次重试间隔毫秒（≥ 0 整数） */
  retryDelayMs: number;
  /** 窗口初始宽度（≥ minWidth 整数） */
  width: number;
  /** 窗口初始高度（≥ minHeight 整数） */
  height: number;
  /** 窗口最小宽度（≥ 1 整数） */
  minWidth: number;
  /** 窗口最小高度（≥ 1 整数） */
  minHeight: number;
  /** 是否启用在线更新检测（默认 true；运维可设 false 关闭） */
  autoUpdate: boolean;
  /** 更新通道：stable（仅正式版）/ beta（含预发布 rc / beta 版本） */
  updateChannel: UpdateChannel;
  /** dismiss 后静默期（小时）。0=立即重提示，>0=静默，默认 24 */
  dismissCooldownHours: number;
  /**
   * 视图策略开关
   * - true（默认）：offline-first。app 启动直接显示离线页，URL 异步加载；失败/崩溃 → 留在离线页（TopBar「重新连接」可点）
   * - false：旧流程。先显示 splash；URL 失败 → retryView 重试 N 次 → errorView（error 页「重试」按钮触发新一轮）
   */
  useOfflineFallback: boolean;
  /**
   * 编码工具列表（v1.2 新增）。每次点「写代码」会弹 dialog 列出这些工具，用户选一个后弹目录选择 dialog
   * - type: external ─► spawn detached，外部 IDE 接管
   * - type: embedded ─► spawn 内嵌 web 服务，主进程加载到 codingView
   */
  codingAgent: CodingAgentConfig;
}

/**
 * 已加载配置（含派生字段）
 */
export interface LoadedConfig extends AppConfig {
  /** 由 targetUrl 推导，供 will-navigate 使用 */
  allowedOriginPrefix: string;
}

/** 配置错误基类 */
export class ConfigError extends Error {
  constructor(message: string, readonly configPath: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** JSONC 解析错误 */
export class ConfigParseError extends ConfigError {
  constructor(message: string, configPath: string) {
    super(message, configPath);
    this.name = 'ConfigParseError';
  }
}

/** 字段校验错误 */
export class ConfigValidationError extends ConfigError {
  constructor(message: string, configPath: string) {
    super(message, configPath);
    this.name = 'ConfigValidationError';
  }
}

/** 配置文件不存在错误 */
export class ConfigNotFoundError extends ConfigError {
  constructor(readonly triedPaths: string[], configPath: string) {
    super(`未找到 config.jsonc`, configPath);
    this.name = 'ConfigNotFoundError';
  }
}

/**
 * 解析平台特定的 bundled default 路径
 * macOS:   <exec>/../Resources/config.jsonc（extraResources 落地位置，codesign 兼容）
 * Windows: <exec-dir>/resources/config.jsonc（extraResources 落地位置）
 */
function getBundledConfigPath(): string {
  const execDir = path.dirname(process.execPath);
  if (process.platform === 'darwin') {
    return path.join(execDir, '..', 'Resources', 'config.jsonc');
  }
  return path.join(execDir, 'resources', 'config.jsonc');
}

/**
 * 解析 config.jsonc 实际路径
 * - dev 模式（app.isPackaged === false）：cwd/config.jsonc（保持现状）
 * - 生产模式：
 *   1) userData/config.jsonc 存在 → 用它（用户编辑生效）
 *   2) 不存在 → 从 bundled default 复制到 userData
 *   3) 复制失败（权限/磁盘） → 降级读 bundled（编辑不持久化但能跑）
 *   4) bundled 也缺失 → 抛 ConfigNotFoundError
 */
export async function resolveConfigPath(): Promise<string> {
  // dev 模式：cwd 行为保持现状
  if (!app.isPackaged) {
    const devPath = path.join(process.cwd(), 'config.jsonc');
    if (fs.existsSync(devPath)) {
      return devPath;
    }
    throw new ConfigNotFoundError([devPath], devPath);
  }

  // 生产模式：userData 优先
  const userConfigPath = path.join(app.getPath('userData'), 'config.jsonc');

  if (fs.existsSync(userConfigPath)) {
    return userConfigPath;
  }

  // userData 没有 → 从 bundled 复制
  const bundledPath = getBundledConfigPath();

  if (!fs.existsSync(bundledPath)) {
    throw new ConfigNotFoundError(
      [userConfigPath, bundledPath],
      userConfigPath,
    );
  }

  try {
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.copyFileSync(bundledPath, userConfigPath);
    log.info(`✓ 已初始化用户配置: ${userConfigPath}`);
    return userConfigPath;
  } catch (err) {
    // 复制失败（权限/磁盘/只读卷）→ 降级读 bundled
    log.warn(
      `⚠ 无法写入 userData: ${(err as Error).message}`,
    );
    log.warn(
      `回退到 bundled default（用户编辑不会持久化）: ${bundledPath}`,
    );
    return bundledPath;
  }
}

/**
 * 校验 codingAgent.tools 数组（v1.2 新增）
 * - 必须是数组，至少 1 个工具
 * - id 非空 + 唯一
 * - type: 'external' | 'embedded'
 * - external: dirMode ∈ {positional, cwd, none}，args/path 可选
 * - embedded: dirMode ∈ {positional, cwd}，args 必填为字符串数组，port ∈ [1, 65535]
 */
function validateCodingTools(raw: unknown, configPath: string): CodingTool[] {
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(`codingAgent.tools 必须是数组`, configPath);
  }
  if (raw.length === 0) {
    throw new ConfigValidationError('codingAgent.tools 至少要有 1 个工具', configPath);
  }

  const errors: string[] = [];
  const ids = new Set<string>();
  const tools: CodingTool[] = [];

  raw.forEach((rawTool, i) => {
    const tag = `codingAgent.tools[${i}]`;
    const toolErrors: string[] = [];
    if (typeof rawTool !== 'object' || rawTool === null) {
      errors.push(`${tag} 必须是对象`);
      return;
    }
    const t = rawTool as Record<string, unknown>;

    if (typeof t.id !== 'string' || t.id.length === 0) {
      toolErrors.push(`${tag}.id 必须是非空字符串`);
      errors.push(...toolErrors);
      return;
    }
    if (ids.has(t.id)) {
      toolErrors.push(`${tag}.id 重复: "${t.id}"`);
      errors.push(...toolErrors);
      return;
    }
    ids.add(t.id);

    if (typeof t.name !== 'string' || t.name.length === 0) {
      toolErrors.push(`${tag}.name 必须是非空字符串`);
    }
    if (t.description !== undefined && typeof t.description !== 'string') {
      toolErrors.push(`${tag}.description 必须是字符串（可选）`);
    }
    if (t.type !== 'external' && t.type !== 'embedded' && t.type !== 'url') {
      toolErrors.push(`${tag}.type 必须是 'external'|'embedded'|'url'`);
      errors.push(...toolErrors);
      return;
    }
    // url 类型不要求 command（直接给 url 就行）；external/embedded 必填 command
    if (t.type !== 'url') {
      if (typeof t.command !== 'string' || t.command.length === 0) {
        toolErrors.push(`${tag}.command 必须是非空字符串`);
      }
    }

    if (t.type === 'external') {
      const allowedDir = ['positional', 'cwd', 'none'];
      if (typeof t.dirMode !== 'string' || !allowedDir.includes(t.dirMode)) {
        toolErrors.push(`${tag}.dirMode 必须是 'positional'|'cwd'|'none'`);
      }
      if (t.args !== undefined && !Array.isArray(t.args)) {
        toolErrors.push(`${tag}.args 必须是字符串数组（可选）`);
      }
      if (t.path !== undefined && typeof t.path !== 'string') {
        toolErrors.push(`${tag}.path 必须是字符串（可选）`);
      }
      if (toolErrors.length === 0) {
        tools.push({
          id: t.id as string, name: t.name as string,
          ...(t.description !== undefined ? { description: t.description as string } : {}),
          type: 'external', command: t.command as string,
          ...(t.path !== undefined ? { path: t.path as string } : {}),
          ...(t.args !== undefined ? { args: t.args as string[] } : { args: [] }),
          dirMode: t.dirMode as 'positional' | 'cwd' | 'none',
        });
      }
    } else if (t.type === 'embedded') {
      const allowedDir = ['positional', 'cwd'];
      if (typeof t.dirMode !== 'string' || !allowedDir.includes(t.dirMode)) {
        toolErrors.push(`${tag}.dirMode 必须是 'positional'|'cwd'`);
      }
      if (!Array.isArray(t.args)) toolErrors.push(`${tag}.args 必须是字符串数组`);
      if (!Number.isInteger(t.port) || (t.port as number) < 1 || (t.port as number) > 65535) {
        toolErrors.push(`${tag}.port 必须是 1-65535 的整数`);
      }
      if (toolErrors.length === 0) {
        tools.push({
          id: t.id as string, name: t.name as string,
          ...(t.description !== undefined ? { description: t.description as string } : {}),
          type: 'embedded', command: t.command as string,
          args: t.args as string[], port: t.port as number,
          dirMode: t.dirMode as 'positional' | 'cwd',
        });
      }
    } else {
      // url 类型：校验 url 是合法 http(s) URL
      if (typeof t.url !== 'string' || t.url.length === 0) {
        toolErrors.push(`${tag}.url 必须是非空字符串`);
      } else {
        let parsed: URL;
        try {
          parsed = new URL(t.url);
        } catch {
          toolErrors.push(`${tag}.url 必须是合法 URL (实际: "${t.url}")`);
          parsed = null as unknown as URL;
        }
        if (parsed && (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          toolErrors.push(`${tag}.url 协议必须是 http: 或 https: (实际: ${parsed.protocol})`);
        }
      }
      // url 类型不能同时设 command/path/args/port/dirMode（语义冲突）
      if (t.command !== undefined) toolErrors.push(`${tag}.url 类型不能设 command`);
      if (t.path !== undefined) toolErrors.push(`${tag}.url 类型不能设 path`);
      if (t.args !== undefined) toolErrors.push(`${tag}.url 类型不能设 args`);
      if (t.port !== undefined) toolErrors.push(`${tag}.url 类型不能设 port`);
      if (t.dirMode !== undefined) toolErrors.push(`${tag}.url 类型不能设 dirMode`);
      if (toolErrors.length === 0) {
        tools.push({
          id: t.id as string, name: t.name as string,
          ...(t.description !== undefined ? { description: t.description as string } : {}),
          type: 'url', url: t.url as string,
        });
      }
    }

    errors.push(...toolErrors);
  });

  if (errors.length > 0) throw new ConfigValidationError(errors.join('\n  - '), configPath);
  return tools;
}

/**
 * 校验配置对象的 12 个字段（缺失 / 类型 / 范围）
 */
function validateConfig(obj: unknown, configPath: string): AppConfig {
  if (typeof obj !== 'object' || obj === null) {
    throw new ConfigValidationError('config.jsonc 必须是 JSON 对象', configPath);
  }
  const o = obj as Record<string, unknown>;

  const errors: string[] = [];

  // targetUrl
  if (!('targetUrl' in o)) {
    errors.push('字段 targetUrl 缺失');
  } else if (typeof o.targetUrl !== 'string' || o.targetUrl.length === 0) {
    errors.push('targetUrl 必须是非空字符串');
  } else if (!/^https?:\/\//.test(o.targetUrl)) {
    errors.push(`targetUrl 必须是合法的 http(s) URL (实际: "${o.targetUrl}")`);
  } else {
    try {
      new URL(o.targetUrl);
    } catch {
      errors.push(`targetUrl 必须是合法的 URL (实际: "${o.targetUrl}")`);
    }
  }

  // maxRetries
  if (!('maxRetries' in o)) {
    errors.push('字段 maxRetries 缺失');
  } else if (!Number.isInteger(o.maxRetries) || (o.maxRetries as number) < 0) {
    errors.push(`maxRetries 必须是非负整数 (实际: ${JSON.stringify(o.maxRetries)})`);
  }

  // retryDelayMs
  if (!('retryDelayMs' in o)) {
    errors.push('字段 retryDelayMs 缺失');
  } else if (!Number.isInteger(o.retryDelayMs) || (o.retryDelayMs as number) < 0) {
    errors.push(`retryDelayMs 必须是非负整数 (实际: ${JSON.stringify(o.retryDelayMs)})`);
  }

  // minWidth, minHeight（先校验，用于 width/height 范围判断）
  const minWidth = o.minWidth;
  const minHeight = o.minHeight;
  if (!('minWidth' in o)) {
    errors.push('字段 minWidth 缺失');
  } else if (!Number.isInteger(minWidth) || (minWidth as number) < 1) {
    errors.push(`minWidth 必须是 >= 1 的整数 (实际: ${JSON.stringify(minWidth)})`);
  }
  if (!('minHeight' in o)) {
    errors.push('字段 minHeight 缺失');
  } else if (!Number.isInteger(minHeight) || (minHeight as number) < 1) {
    errors.push(`minHeight 必须是 >= 1 的整数 (实际: ${JSON.stringify(minHeight)})`);
  }

  // width
  if (!('width' in o)) {
    errors.push('字段 width 缺失');
  } else if (!Number.isInteger(o.width) || (o.width as number) < 1) {
    errors.push(`width 必须是 >= 1 的整数 (实际: ${JSON.stringify(o.width)})`);
  } else if (Number.isInteger(minWidth) && (o.width as number) < (minWidth as number)) {
    errors.push(`width (${o.width}) 必须 >= minWidth (${minWidth})`);
  }

  // height
  if (!('height' in o)) {
    errors.push('字段 height 缺失');
  } else if (!Number.isInteger(o.height) || (o.height as number) < 1) {
    errors.push(`height 必须是 >= 1 的整数 (实际: ${JSON.stringify(o.height)})`);
  } else if (Number.isInteger(minHeight) && (o.height as number) < (minHeight as number)) {
    errors.push(`height (${o.height}) 必须 >= minHeight (${minHeight})`);
  }

  // autoUpdate
  if (!('autoUpdate' in o)) {
    errors.push('字段 autoUpdate 缺失');
  } else if (typeof o.autoUpdate !== 'boolean') {
    errors.push(`autoUpdate 必须是 boolean (实际: ${JSON.stringify(o.autoUpdate)})`);
  }

  // updateChannel
  if (!('updateChannel' in o)) {
    errors.push('字段 updateChannel 缺失');
  } else if (o.updateChannel !== 'stable' && o.updateChannel !== 'beta') {
    errors.push(`updateChannel 必须是 'stable' 或 'beta' (实际: ${JSON.stringify(o.updateChannel)})`);
  }

  // dismissCooldownHours
  if (!('dismissCooldownHours' in o)) {
    errors.push('字段 dismissCooldownHours 缺失');
  } else if (!Number.isInteger(o.dismissCooldownHours) || (o.dismissCooldownHours as number) < 0) {
    errors.push(`dismissCooldownHours 必须是非负整数 (实际: ${JSON.stringify(o.dismissCooldownHours)})`);
  }

  // useOfflineFallback
  if (!('useOfflineFallback' in o)) {
    errors.push('字段 useOfflineFallback 缺失');
  } else if (typeof o.useOfflineFallback !== 'boolean') {
    errors.push(`useOfflineFallback 必须是 boolean (实际: ${JSON.stringify(o.useOfflineFallback)})`);
  }

  // codingAgent（v1.2 新增）
  let validatedTools: CodingTool[] = [];
  if (!('codingAgent' in o) || !o.codingAgent) {
    errors.push('字段 codingAgent 缺失');
  } else {
    validatedTools = validateCodingTools(
      (o.codingAgent as Record<string, unknown>).tools, configPath
    );
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors.join('\n  - '), configPath);
  }

  return {
    targetUrl: o.targetUrl as string,
    maxRetries: o.maxRetries as number,
    retryDelayMs: o.retryDelayMs as number,
    width: o.width as number,
    height: o.height as number,
    minWidth: o.minWidth as number,
    minHeight: o.minHeight as number,
    autoUpdate: o.autoUpdate as boolean,
    updateChannel: o.updateChannel as UpdateChannel,
    dismissCooldownHours: o.dismissCooldownHours as number,
    useOfflineFallback: o.useOfflineFallback as boolean,
    codingAgent: { tools: validatedTools },
  };
}

/**
 * 加载并校验 config.jsonc
 * 失败时 log.error（写 main.log + console）+ process.exit(1)
 *
 * 向后兼容：用户 config 缺字段时，从 bundled default 补齐并写回 userData
 * - 场景：v0.5.6 → v0.6.0 升级时，旧 config 缺 useOfflineFallback 等新字段
 * - 不覆盖用户的现有字段值（保留 targetUrl 等自定义）
 * - 用 jsonc-parser.modify() 写回，保留用户原有注释和缩进格式
 * - 写回失败时降级为内存合并，下次启动重新尝试
 */
export async function loadConfig(): Promise<LoadedConfig> {
  let configPath: string;
  try {
    configPath = await resolveConfigPath();
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      log.error('✗ 未找到 config.jsonc');
      log.error('  已尝试:');
      for (const p of err.triedPaths) {
        log.error(`    - ${p}`);
      }
      log.error('  提示: 从仓库根或安装包复制 config.jsonc 到上述任一路径');
      process.exit(1);
    }
    throw err;
  }

  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    log.error(`✗ 读取失败: ${configPath}`);
    log.error(`  ${(err as Error).message}`);
    process.exit(1);
  }

  const parseErrors: ParseError[] = [];
  const data = parse(text, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length > 0) {
    const e = parseErrors[0];
    log.error(`✗ JSONC 解析失败: ${configPath}`);
    log.error(`  第 ${e.offset + 1} 字符附近: ${e.error}`);
    process.exit(1);
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    log.error(`✗ config.jsonc 必须是 JSON 对象: ${configPath}`);
    process.exit(1);
  }

  // =============================================================================
  // 向后兼容迁移：缺字段时从 bundled default 补齐并写回 userData
  // 仅生产模式触发（dev 模式仓库根 config.jsonc 永远是最新源）
  // =============================================================================
  const userObj = data as Record<string, unknown>;
  const bundledConfigPath = getBundledConfigPath();
  if (app.isPackaged && configPath !== bundledConfigPath) {
    try {
      const bundledText = fs.readFileSync(bundledConfigPath, 'utf-8');
      const bundledParseErrors: ParseError[] = [];
      const bundledData = parse(bundledText, bundledParseErrors, { allowTrailingComma: true });
      if (
        bundledParseErrors.length === 0 &&
        typeof bundledData === 'object' &&
        bundledData !== null &&
        !Array.isArray(bundledData)
      ) {
        const bundledObj = bundledData as Record<string, unknown>;
        const missing = Object.keys(bundledObj).filter((k) => !(k in userObj));
        if (missing.length > 0) {
          log.warn(`⚠ 用户配置缺失字段: ${missing.join(', ')}`);
          log.warn(`  从 bundled default 补齐并写回: ${configPath}`);
          log.warn(`  提示: 写回后用户原有注释/缩进保留，可编辑文件改默认值`);

          // 用 modify() 增量插入新字段（modify 返回 ApplyEdits[]，需 applyEdits 应用）
          let mergedText = text;
          let modifyFailed = false;
          for (const field of missing) {
            const edits = modify(mergedText, [field], bundledObj[field], {
              formattingOptions: { tabSize: 2, insertSpaces: true },
            });
            if (edits === undefined) {
              log.error(`  ✗ modify() 写入字段 ${field} 失败，仅内存兜底`);
              modifyFailed = true;
              userObj[field] = bundledObj[field]; // 内存兜底
            } else {
              const applied = applyEdits(mergedText, edits);
              if (applied === undefined) {
                log.error(`  ✗ applyEdits() 写入字段 ${field} 失败，仅内存兜底`);
                modifyFailed = true;
                userObj[field] = bundledObj[field];
              } else {
                mergedText = applied;
                userObj[field] = bundledObj[field];
              }
            }
          }

          if (!modifyFailed) {
            try {
              fs.writeFileSync(configPath, mergedText, 'utf-8');
              log.info(`✓ 已写回迁移后的配置: ${configPath}`);
            } catch (writeErr) {
              log.error(
                `✗ 写回失败: ${(writeErr as Error).message}（仅内存使用，下次启动需重新迁移）`,
              );
            }
          }
        }
      }
    } catch (readErr) {
      log.warn(`⚠ bundled config 不可读，跳过迁移兜底: ${(readErr as Error).message}`);
    }
  }

  let validated: AppConfig;
  try {
    validated = validateConfig(userObj, configPath);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      log.error(`✗ 字段校验失败: ${configPath}`);
      log.error(`  - ${err.message}`);
      log.error(`  提示: 编辑 config.jsonc 修正后重启，或删除该文件从 bundled 重新生成`);
      process.exit(1);
    }
    throw err;
  }

  // 派生 allowedOriginPrefix
  let allowedOriginPrefix: string;
  try {
    allowedOriginPrefix = new URL(validated.targetUrl).origin + '/';
  } catch {
    log.error(`✗ targetUrl 无法解析为 URL: ${validated.targetUrl}`);
    process.exit(1);
  }

  log.info(`✓ 已加载 ${configPath}`);
  log.info(`targetUrl: ${validated.targetUrl}`);
  log.info(`窗口: ${validated.width}x${validated.height} (min ${validated.minWidth}x${validated.minHeight})`);
  log.info(`重试: ${validated.maxRetries} 次, 间隔 ${validated.retryDelayMs}ms`);
  log.info(`视图策略: ${validated.useOfflineFallback ? 'offline-first（默认显示离线页，URL 异步加载）' : 'splash → retry → error（旧流程）'}`);

  return { ...validated, allowedOriginPrefix };
}