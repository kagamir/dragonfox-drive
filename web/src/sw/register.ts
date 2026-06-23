/** Service-Worker registration + a promise that resolves once a controller is active. */

let ensurePromise: Promise<void> | null = null;

// In dev, vite-plugin-pwa serves the compiled SW at `/dev-sw.js?dev-sw`
// (DEV_SW_NAME constant inside the plugin); `/sw.js` only exists in the
// production build. Registering the wrong path makes Vite's SPA fallback
// return index.html, which the browser rejects with
// "The script has an unsupported MIME type ('text/html')".
const SW_URL = import.meta.env.DEV ? "/dev-sw.js?dev-sw" : "/sw.js";

export function ensureStreamSw(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) {
    return Promise.reject(new Error("service worker unsupported"));
  }
  const sw = navigator.serviceWorker;
  if (sw.controller) return Promise.resolve();
  if (ensurePromise) return ensurePromise;
  ensurePromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const onReady = () => {
      if (!settled && sw.controller) {
        settled = true;
        sw.removeEventListener("controllerchange", onReady);
        ensurePromise = null;
        resolve();
      }
    };
    sw.addEventListener("controllerchange", onReady);
    sw.register(SW_URL, { type: "module" }).then(onReady).catch((e: unknown) => {
      if (!settled) {
        settled = true;
        sw.removeEventListener("controllerchange", onReady);
        ensurePromise = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
  return ensurePromise;
}

export function postToSw(msg: unknown): void {
  navigator.serviceWorker?.controller?.postMessage(msg);
}
