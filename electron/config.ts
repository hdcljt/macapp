import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, modify, applyEdits, ParseError } from 'jsonc-parser';
import { logger } from './logger';

const log = logger.child('config');

/** 更新通道：stable（仅正式版）/ beta（含预发布 rc / beta 版本） */
export type UpdateChannel = 'stable' | 'beta';

/**
 * 应用配置 schema（11 字段，全部必填）
 *
 * 视图策略由 `useOfflineFallback` 字段控制：
 * - true（v0.6.0+ 默认）：offline-first，app 启动直接显示离线页，URL 异步加载
 * - false：splash → retry → error 旧流程，contentView 失败时重试 N 次后切到错误页
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
 * 解析平台特定的 exe-dir 配置路径
 * macOS: <exec>/../Resources/config.jsonc（mac.extraResources 落地位置）
 *   注意：必须放在 Contents/Resources/，否则 codesign 拒绝签名 Contents/ 根目录的非代码文件
 * 其他:  <exec-dir>/config.jsonc（win.extraFiles 落地位置）
 */
function getExecDirConfigPath(): string {
  const execDir = path.dirname(process.execPath);
  if (process.platform === 'darwin') {
    return path.join(execDir, '..', 'Resources', 'config.jsonc');
  }
  return path.join(execDir, 'config.jsonc');
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
 * 校验配置对象的 11 个字段（缺失 / 类型 / 范围）
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