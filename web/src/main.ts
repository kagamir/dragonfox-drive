import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App.vue";
import { router } from "./router";
import { initCrypto } from "./crypto";
import { i18n } from "./locales";
import { useAuthStore } from "./stores/auth";

import "./styles/main.css";

async function bootstrap() {
  // Initialise WASM-backed crypto primitives (libsodium) before anything else.
  await initCrypto();

  const app = createApp(App);
  app.use(createPinia());
  app.use(i18n);
  app.use(router);

  // Kick off the async session restore before mounting. The router guard
  // awaits the same promise, so the first navigation waits for the
  // refresh-token exchange to settle instead of seeing a transient
  // unauthenticated state (which previously caused a false logout on refresh).
  useAuthStore().ensureSessionRestored();

  app.mount("#app");
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to bootstrap application:", err);
  const fallback = document.createElement("pre");
  fallback.style.padding = "1rem";
  fallback.style.whiteSpace = "pre-wrap";
  fallback.textContent = `Failed to start DragonFox Drive:\n${String(err)}`;
  document.getElementById("app")?.replaceWith(fallback);
});
