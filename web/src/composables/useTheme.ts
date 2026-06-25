import { useColorMode } from "@vueuse/core";

export type ThemeMode = "auto" | "light" | "dark";

/**
 * 全局明暗主题。light 不加 class；dark 给 <html> 加 .dark。
 * 持久化到 localStorage["df-theme"]，首次跟随系统偏好。
 */
export function useTheme() {
  return useColorMode({
    storageKey: "df-theme",
    initialValue: "auto",
    selector: "html",
    attribute: "class",
    modes: {
      auto: "",
      light: "",
      dark: "dark",
    },
  });
}
