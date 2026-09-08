import { ElMessage } from 'element-plus';
import type { CodingStatus } from '@/types/coding';

/**
 * 把 CodingStatus 映射成 Element Plus 顶栏 toast 提示。
 *
 * 设计要点（两阶段 switch）：
 * 1. 第一阶段按状态分发，决定是否清场：
 *    - spawning-embedded：常驻 toast（duration=0），不关闭（用户等待 ready/失败）。
 *      showClose:true 让用户可手动关闭，避免极端情况下 UI 卡住。
 *    - 其它所有状态：先 ElMessage.closeAll() 清掉上一次的 spawning-embedded
 *      常驻 toast；之后可能弹新 toast。
 * 2. 第二阶段按状态分发，决定弹什么 toast：
 *    - launching-external：2s info
 *    - spawning-embedded：已在第一阶段处理
 *    - ready-embedded：2s success（绿色对勾，UX 更好）
 *    - spawn-failed / timeout / exited：4s error + grouping（同 message 内容不堆叠）
 *    - idle：静默（已在第一阶段 closeAll）
 *
 * 历史 bug：
 *   - 旧版只在 ready-embedded closeAll，spawning-embedded 的所有失败后继
 *     （timeout / exited / spawn-failed）都不关闭那条 duration:0 的常驻 toast，
 *     出现「启动失败 + 正在启动内嵌工具…」两条同屏。修法：进入任何非 spawning
 *     状态都先 closeAll。
 *
 * Element Plus 2.9.10 ElMessage 类型仅支持 `(options?: MessageParamsWithType)`
 * 单参形式（无 message + options 两参 overload），故统一用对象字面量。
 *
 * 调用方：coding-dialog.ts 的 onStatus 订阅回调。
 */
export function codingToast(status: CodingStatus): void {
  // 第一阶段：决定 closeAll 与否
  switch (status.state) {
    case 'spawning-embedded':
      ElMessage.info({
        message: '正在启动内嵌工具…',
        duration: 0,
        grouping: true,
        showClose: true,
      });
      return;
    default:
      ElMessage.closeAll();
      break;
  }

  // 第二阶段：分别弹对应 toast
  switch (status.state) {
    case 'launching-external':
      ElMessage.info({ message: '正在启动外部 IDE…', duration: 2000, grouping: true });
      break;
    case 'ready-embedded':
      ElMessage.success({ message: '内嵌工具已就绪', duration: 2000, grouping: true });
      break;
    case 'spawn-failed':
      ElMessage.error({
        message: `启动失败：${status.message}`,
        duration: 4000,
        grouping: true,
      });
      break;
    case 'timeout':
      ElMessage.error({
        message: '工具启动超时（5s 未就绪）',
        duration: 4000,
        grouping: true,
      });
      break;
    // case 'exited':
    //   主动 shutdown 老 child 也会触发 exited（taskkill /f /t 给非 0 exit code），
    //   这种"主动退出"不该弹 toast 打扰用户；真异常退出通常意味着开发期 bug，靠主进程日志诊断即可。
    //   暂时注释掉整个 case，留作未来真要提示时再加回来。
    //   ElMessage.error({
    //     message: `工具已退出（code=${status.code}）`,
    //     duration: 4000,
    //     grouping: true,
    //   });
    //   break;
    case 'idle':
      // 第一阶段已处理（spawning 弹常驻；idle 已 closeAll）
      break;
  }
}
