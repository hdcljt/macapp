/**
 * coding 类型镜像（offline-app 侧）
 *
 * 与 electron/config.ts 的 CodingTool + electron/codingAgent.ts 的 CodingStatus 完全镜像。
 * 用于 renderer 侧 dialog/toast 的类型约束；不做运行时 type guards（plan Task 5 精简时去掉）。
 *
 * 不使用 import type 直接引 electron 路径：renderer 侧打包不应耦合主进程源码路径。
 */

export type DirMode = 'positional' | 'cwd' | 'none';

export interface CodingToolBase {
  id: string;
  name: string;
  description?: string;
}

export interface ExternalTool extends CodingToolBase {
  type: 'external';
  command: string;
  path?: string;
  args?: string[];
  dirMode: DirMode;
}

export interface EmbeddedTool extends CodingToolBase {
  type: 'embedded';
  command: string;
  args: string[];
  port: number;
  dirMode: Exclude<DirMode, 'none'>;
}

export type CodingTool = ExternalTool | EmbeddedTool;

export type CodingStatus =
  | { state: 'idle' }
  | { state: 'launching-external'; toolId: string }
  | { state: 'spawning-embedded'; toolId: string }
  | { state: 'ready-embedded'; url: string; toolId: string }
  | { state: 'spawn-failed'; message: string }
  | { state: 'timeout' }
  | { state: 'exited'; code: number; toolId: string };
