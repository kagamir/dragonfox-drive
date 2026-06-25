import { ref, readonly } from "vue";

export interface PromptOptions {
  message: string;
  title?: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  cancelText?: string;
}
interface State extends PromptOptions { open: boolean; resolve: ((v: string | null) => void) | null; }

const state = ref<State>({ open: false, message: "", resolve: null });

export function usePrompt() {
  return {
    state: readonly(state),
    prompt(opts: PromptOptions): Promise<string | null> {
      return new Promise((resolve) => {
        state.value = {
          open: true, resolve,
          title: opts.title ?? "输入",
          message: opts.message,
          placeholder: opts.placeholder ?? "",
          initial: opts.initial ?? "",
          confirmText: opts.confirmText ?? "确认",
          cancelText: opts.cancelText ?? "取消",
        };
      });
    },
    _submit(v: string | null) {
      state.value.resolve?.(v);
      state.value = { open: false, message: "", resolve: null };
    },
  };
}
