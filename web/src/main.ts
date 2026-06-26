import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App.vue";
import { router } from "./router";
import { initCrypto } from "./crypto";
import { i18n } from "./locales";

import "./styles/main.css";

async function bootstrap() {
  // Initialise WASM-backed crypto primitives (libsodium) before anything else.
  await initCrypto();

  const app = createApp(App);
  app.use(createPinia());
  app.use(i18n);
  app.use(router);
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
