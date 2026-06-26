// web/src/locales/index.ts
import { createI18n } from "vue-i18n";
import en from "./en";
import zh from "./zh";

export const SUPPORTED = ["en", "zh"] as const;
export type AppLocale = (typeof SUPPORTED)[number];

export function detectLocale(navLang?: string): AppLocale {
  const saved = localStorage.getItem("df-lang");
  if (saved === "en" || saved === "zh") return saved;
  const lang = navLang ?? (typeof navigator !== "undefined" ? navigator.language : "en");
  return lang && lang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function setLocale(locale: AppLocale): void {
  localStorage.setItem("df-lang", locale);
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "en",
  messages: { en, zh },
  missingWarn: false,
  fallbackWarn: false,
});
