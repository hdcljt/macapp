import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { CodingTool, CodingStatus } from '@/types/coding';
import { codingToast } from '@/coding-toast';

/**
 * 工具选择 dialog 的可见性 + tools 列表。
 *
 * 模块级 ref 是 Vue 3 单例模式：在 App.vue setup() 顶层 import，跨组件共享 dialog 状态。
 *   - visible / tools 由 App.vue 通过 :visible / :tools 传给 <ToolPickerDialog>
 *   - openCodingDialog() 写 visible=true + tools
 *   - onToolPicked() / onToolPickCancelled() 写 visible=false
 *
 * 生命周期：
 *   - initCodingDialog()：App.vue onMounted 时挂 status 订阅 + 拿 initial status
 *   - disposeCodingDialog()：App.vue onUnmounted 时清理订阅（HMR 友好）
 *
 * Dev 模式 fallback：window.electronAPI 不存在时所有 IPC 调用走静默路径，
 *   让 `npm run dev` 跑纯浏览器时也能看到 UI（不会抛 TypeError）。
 */

// module-scope 单例状态
const visible = ref(false);
const tools = ref<CodingTool[]>([]);

let unsubscribeStatus: (() => void) | null = null;

/**
 * 初始化：在 App.vue onMounted 调一次。
 * - 取 initial status（renderer 重启时主进程可能已有 launching-external 等状态）
 * - 订阅后续 status 推送（每次状态变化触发 codingToast）
 *
 * dev 模式（无 window.electronAPI）静默返回。
 */
export function initCodingDialog(): void {
  if (!window.electronAPI) return;

  // 取 initial status
  window.electronAPI.coding
    .getInitialStatus()
    .then((raw) => {
      if (raw && typeof raw === 'object' && 'state' in (raw as object)) {
        codingToast(raw as CodingStatus);
      }
    })
    .catch(() => {
      // 静默：getInitialStatus 失败不影响 UI
    });

  // 订阅后续 status
  unsubscribeStatus = window.electronAPI.coding.onStatus((raw) => {
    if (raw && typeof raw === 'object' && 'state' in (raw as object)) {
      codingToast(raw as CodingStatus);
    }
  });
}

/**
 * 清理：在 App.vue onUnmounted 调一次。
 * 取消 status 订阅；HMR 重新 setup 时避免 listener 累积。
 */
export function disposeCodingDialog(): void {
  unsubscribeStatus?.();
  unsubscribeStatus = null;
}

/**
 * 用户点「写代码」卡片 / 底部 code tab 的主入口。
 * - listTools() → 拿到 tools
 * - tools 为空 → warning
 * - 否则把 tools 写入单例 ref，置 visible=true 让 ToolPickerDialog 显示
 *
 * 失败处理：listTools reject → ElMessage.error；dev 模式仅 console.log 不弹框。
 */
export async function openCodingDialog(): Promise<void> {
  if (!window.electronAPI) {
    console.log('[coding] openCodingDialog (dev mode, no IPC)');
    return;
  }

  let list: unknown[];
  try {
    list = await window.electronAPI.coding.listTools();
  } catch (err) {
    ElMessage.error(`读取工具列表失败：${(err as Error).message}`);
    return;
  }

  if (!Array.isArray(list) || list.length === 0) {
    ElMessage.warning('未配置任何编码工具，请编辑 config.jsonc');
    return;
  }

  tools.value = list as CodingTool[];
  visible.value = true;
}

/**
 * ToolPickerDialog 选完一个 tool 后的回调。
 * 流程：关 dialog → 弹原生目录选择 → openTool(tool.id, dir)
 *
 * chooseDirectory 返回 null 表示用户取消，函数静默返回（已无 dialog 可关）。
 * openTool 失败用 console.warn 而非 ElMessage（codingToast 已会推 spawn-failed 状态）。
 */
export async function onToolPicked(tool: CodingTool): Promise<void> {
  visible.value = false;
  if (!window.electronAPI) return;

  let dir: string | null;
  try {
    dir = await window.electronAPI.coding.chooseDirectory();
  } catch (err) {
    ElMessage.error(`目录选择失败：${(err as Error).message}`);
    return;
  }
  if (!dir) return;

  try {
    await window.electronAPI.coding.openTool(tool.id, dir);
  } catch (err) {
    // codingToast 已会触发 spawn-failed；这里仅记录原始异常
    console.warn('[coding] openTool failed:', (err as Error).message);
  }
}

/** ToolPickerDialog 取消 / 关闭时的回调 */
export function onToolPickCancelled(): void {
  visible.value = false;
}

// 暴露给 App.vue template 绑定
export { visible, tools };
