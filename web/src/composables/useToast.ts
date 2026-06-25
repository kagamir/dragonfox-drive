import { ref, readonly } from "vue";

export type ToastType = "success" | "info" | "warning" | "error";
export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

const list = ref<ToastItem[]>([]);
let seq = 0;

function push(type: ToastType, message: string, duration = 3500): number {
  const id = ++seq;
  list.value.push({ id, type, message });
  if (duration > 0) setTimeout(() => remove(id), duration);
  return id;
}

function remove(id: number) {
  list.value = list.value.filter((t) => t.id !== id);
}

function clear() {
  list.value = [];
}

export function useToast() {
  return {
    items: readonly(list),
    success: (m: string, d?: number) => push("success", m, d),
    info: (m: string, d?: number) => push("info", m, d),
    warning: (m: string, d?: number) => push("warning", m, d),
    error: (m: string, d = 6000) => push("error", m, d),
    remove,
    clear,
  };
}
