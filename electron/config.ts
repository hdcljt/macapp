import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, ParseError } from 'jsonc-parser';

/**
 * 应用配置 schema（7 字段，全部必填）
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
    console.log(`[config] ✓ 已初始化用户配置: ${userConfigPath}`);
    return userConfigPath;
  } catch (err) {
    // 复制失败（权限/磁盘/只读卷）→ 降级读 bundled
    console.warn(
      `[config] ⚠ 无法写入 userData: ${(err as Error).message}`,
    );
    console.warn(
      `[config]   回退到 bundled default（用户编辑不会持久化）: ${bundledPath}`,
    );
    return bundledPath;
  }
}

/**
 * 校验配置对象的 7 个字段（缺失 / 类型 / 范围）
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
  };
}

/**
 * 加载并校验 config.jsonc
 * 失败时 console.error + process.exit(1)
 */
export function loadConfig(): LoadedConfig {
  let configPath: string;
  try {
    configPath = resolveConfigPath();
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      console.error('[config] ✗ 未找到 config.jsonc');
      console.error('[config]   已尝试:');
      for (const p of err.triedPaths) {
        console.error(`[config]     - ${p}`);
      }
      console.error('[config]   提示: 从仓库根或安装包复制 config.jsonc 到上述任一路径');
      process.exit(1);
    }
    throw err;
  }

  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    console.error(`[config] ✗ 读取失败: ${configPath}`);
    console.error(`[config]   ${(err as Error).message}`);
    process.exit(1);
  }

  const parseErrors: ParseError[] = [];
  const data = parse(text, parseErrors, { allowTrailingComma: true });
  if (parseErrors.length > 0) {
    const e = parseErrors[0];
    console.error(`[config] ✗ JSONC 解析失败: ${configPath}`);
    console.error(`[config]   第 ${e.offset + 1} 字符附近: ${e.error}`);
    process.exit(1);
  }

  let validated: AppConfig;
  try {
    validated = validateConfig(data, configPath);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(`[config] ✗ 字段校验失败: ${configPath}`);
      console.error(`[config]   - ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // 派生 allowedOriginPrefix
  let allowedOriginPrefix: string;
  try {
    allowedOriginPrefix = new URL(validated.targetUrl).origin + '/';
  } catch {
    console.error(`[config] ✗ targetUrl 无法解析为 URL: ${validated.targetUrl}`);
    process.exit(1);
  }

  console.log(`[config] ✓ 已加载 ${configPath}`);
  console.log(`[config]   targetUrl: ${validated.targetUrl}`);
  console.log(`[config]   窗口: ${validated.width}x${validated.height} (min ${validated.minWidth}x${validated.minHeight})`);
  console.log(`[config]   重试: ${validated.maxRetries} 次, 间隔 ${validated.retryDelayMs}ms`);

  return { ...validated, allowedOriginPrefix };
}