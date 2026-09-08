import { ElMessage } from 'element-plus';
import type { CodingStatus } from '@/types/coding';

/**
 * 把 CodingStatus 映射成 Element Plus 顶栏 toast 提示。
 *
 * 设计要点：
 * - idle：静默（launching-external 持续到下次 openTool，spawning-embedded 持续到 ready/exited/timeout）
 * - launching-external：2s 自动消失的 info
 * - spawning-embedded：duration=0 持续显示（直到 ready-embedded 触发 closeAll）
 * - ready-embedded：关闭所有（清掉上面的 spawning-embedded）
 * - spawn-failed / timeout / exited：4s error
 *
 * Element Plus 2.9.10 ElMessage 类型仅支持 `(options?: MessageParamsWithType)`
 * 单参形式（无 message + options 两参 overload），故统一用对象字面量。
 *
 * 调用方：coding-dialog.ts 的 onStatus 订阅回调。
 */
export function codingToast(status: CodingStatus): void {
  switch (status.state) {
    case 'launching-external':
      ElMessage.info({ message: '正在启动外部 IDE…', duration: 2000, grouping: true });
      break;
    case 'spawning-embedded':
      ElMessage.info({ message: '正在启动内嵌工具…', duration: 0, grouping: true });
      break;
    case 'ready-embedded':
      ElMessage.closeAll();
      break;
    case 'spawn-failed':
      ElMessage.error({ message: `启动失败：${status.message}`, duration: 4000 });
      break;
    case 'timeout':
      ElMessage.error({ message: '工具启动超时（5s 未就绪）', duration: 4000 });
      break;
    case 'exited':
      ElMessage.error({ message: `工具已退出（code=${status.code}）`, duration: 4000 });
      break;
    case 'idle':
      // 静默：launching-external / spawning-embedded 持续状态不需额外提示
      break;
  }
}
