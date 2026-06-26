import { ref, readonly } from "vue";
import { i18n } from "@/locales";

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}
interface State extends ConfirmOptions {
  open: boolean;
  resolve: ((v: boolean) => void) | null;
}

const state = ref<State>({ open: false, message: "", resolve: null });

export function useConfirm() {
  return {
    state: readonly(state),
    confirm(opts: ConfirmOptions): Promise<boolean> {
      return new Promise((resolve) => {
        state.value = {
          open: true,
          resolve,
          title: opts.title ?? i18n.global.t("dialog.confirmTitle"),
          message: opts.message,
          confirmText: opts.confirmText ?? i18n.global.t("dialog.confirm"),
          cancelText: opts.cancelText ?? i18n.global.t("dialog.cancel"),
          danger: opts.danger ?? false,
        };
      });
    },
    _resolve(v: boolean) {
      state.value.resolve?.(v);
      state.value = { open: false, message: "", resolve: null };
    },
  };
}
