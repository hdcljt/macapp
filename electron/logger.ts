import { app, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(module: string): Logger;
}

interface State {
  initialized: boolean;
  logFilePath: string | null;
}

const state: State = { initialized: false, logFilePath: null };

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB
const LOG_BASENAME = 'main.log';
const MAX_BACKUPS = 3;

function getLogDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function getLogPath(): string {
  return path.join(getLogDir(), LOG_BASENAME);
}

function getBackupPath(n: number): string {
  return path.join(getLogDir(), `${LOG_BASENAME}.${n}`);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatLine(level: LogLevel, module: string, message: string): string {
  return `${timestamp()} [${level.toUpperCase()}] [${module}] ${message}`;
}

function consoleOutput(level: LogLevel, line: string): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function rotateIfNeeded(): void {
  if (!state.logFilePath) return;
  let size: number;
  try {
    size = fs.statSync(state.logFilePath).size;
  } catch {
    return;
  }
  if (size < MAX_LOG_BYTES) return;

  try {
    if (fs.existsSync(getBackupPath(MAX_BACKUPS))) {
      fs.unlinkSync(getBackupPath(MAX_BACKUPS));
    }
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const from = getBackupPath(i);
      const to = getBackupPath(i + 1);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(state.logFilePath)) {
      fs.renameSync(state.logFilePath, getBackupPath(1));
    }
  } catch (err) {
    console.error(`[logger] rotate failed: ${(err as Error).message}`);
  }
}

function writeRaw(line: string): void {
  if (!state.initialized || !state.logFilePath) return;
  try {
    fs.appendFileSync(state.logFilePath, line + os.EOL);
    rotateIfNeeded();
  } catch (err) {
    console.error(`[logger] write failed: ${(err as Error).message}`);
  }
}

function write(level: LogLevel, module: string, message: string): void {
  const line = formatLine(level, module, message);
  consoleOutput(level, line);
  writeRaw(line);
}

function makeLogger(module: string): Logger {
  return {
    debug: (msg) => write('debug', module, msg),
    info:  (msg) => write('info',  module, msg),
    warn:  (msg) => write('warn',  module, msg),
    error: (msg) => write('error', module, msg),
    child: (sub) => makeLogger(`${module}.${sub}`),
  };
}

export const logger: Logger = makeLogger('app');

export function initLogger(): void {
  if (!app.isReady()) {
    throw new Error('initLogger must be called after app.whenReady()');
  }
  if (state.initialized) return;

  const logDir = getLogDir();
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.error(`[logger] mkdirSync failed: ${(err as Error).message}`);
    return;
  }

  state.logFilePath = getLogPath();
  state.initialized = true;

  rotateIfNeeded();

  const header = `=== log started at ${new Date().toISOString()} (${process.platform}, electron ${process.versions.electron}) ===`;
  writeRaw(header);
  console.log(header);
}

export function closeLogger(): void {
  if (!state.initialized) return;
  const footer = `=== log ended at ${new Date().toISOString()} ===`;
  writeRaw(footer);
  console.log(footer);
}

export function registerLogHandlers(): void {
  ipcMain.handle('log:write', (_event, level: string, message: string) => {
    const rendererLog = logger.child('renderer');
    switch (level) {
      case 'debug': rendererLog.debug(String(message)); break;
      case 'info':  rendererLog.info(String(message));  break;
      case 'warn':  rendererLog.warn(String(message));  break;
      case 'error': rendererLog.error(String(message)); break;
      default:      rendererLog.info(`[level=${level}] ${String(message)}`); break;
    }
  });
}