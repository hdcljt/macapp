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
 *
 * 注意：renderer 是 sandboxed，process 全局不可用 → 不能用 process.cwd()。
 * dir 由主进程自己定（process.cwd() 或配置字段），renderer 只发 toolId。
 *
 * openTool 早退路径兜底：main 进程 handler 的早退分支（codingAgent 未初始化
 * / unknown-tool / catch）只 return { ok:false, ... } 而不 emit status。
 * 现在取返回结果：ok=false 直接 ElMessage.error 提示。
 */
export async function onToolPicked(tool: CodingTool): Promise<void> {
  visible.value = false;
  if (!window.electronAPI) return;

  try {
    const result = await window.electronAPI.coding.openTool(tool.id);
    if (result && result.ok === false && result.message) {
      ElMessage.error({ message: `启动失败：${result.message}`, duration: 4000, grouping: true });
    }
  } catch (err) {
    ElMessage.error({ message: `启动失败：${(err as Error).message}`, duration: 4000, grouping: true });
  }
}

/** ToolPickerDialog 取消 / 关闭时的回调 */
export function onToolPickCancelled(): void {
  visible.value = false;
}

// 暴露给 App.vue template 绑定
export { visible, tools };
