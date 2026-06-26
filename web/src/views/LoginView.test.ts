import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "@/locales";

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ login: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/stores/config", () => ({
  useConfigStore: () => ({ loaded: true, allowRegistration: true }),
}));
vi.mock("@/composables/useTheme", () => ({
  useTheme: () => ({ store: { value: "light" } }),
}));
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  RouterLink: { template: "<a><slot /></a>" },
}));

import LoginView from "./LoginView.vue";

const stubs = { RouterLink: { template: "<a><slot /></a>" } };

// i18n smoke test: proves locale switching works end-to-end through a real
// view. The view renders auth.tagline + the submit button label from the
// message pack, so flipping i18n.global.locale must surface the other language.
describe("LoginView i18n", () => {
  const original = i18n.global.locale.value;
  beforeEach(() => {
    setActivePinia(createPinia());
    i18n.global.locale.value = "en";
  });
  afterEach(() => {
    i18n.global.locale.value = original;
  });

  it("renders English copy when locale=en and Chinese copy when locale=zh", async () => {
    const w = mount(LoginView, { global: { stubs, plugins: [i18n] } });
    // English: tagline + submit button come from the en message pack.
    expect(w.text()).toContain(i18n.global.t("auth.tagline"));
    const enSubmit = w.find('[data-testid="login-submit"]');
    expect(enSubmit.text()).toBe("Sign in");

    // Switch locale to zh; the same component instance must re-render in Chinese
    // without remounting, proving reactivity through useI18n().
    i18n.global.locale.value = "zh";
    await w.vm.$nextTick();
    expect(w.text()).toContain(i18n.global.t("auth.tagline"));
    const zhSubmit = w.find('[data-testid="login-submit"]');
    expect(zhSubmit.text()).toBe("登录");
  });
});
