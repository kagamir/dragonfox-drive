import { describe, it, expect, beforeEach, vi } from "vitest";

function stubServiceWorker(over: Partial<ServiceWorkerContainer> = {}) {
  const controller = over.controller ?? null;
  const sw = {
    controller,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    register: vi.fn().mockResolvedValue({}),
    ...over,
  } as unknown as ServiceWorkerContainer;
  vi.stubGlobal("navigator", { ...((globalThis as any).navigator ?? {}), serviceWorker: sw });
  return sw;
}

describe("ensureStreamSw", () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });

  it("rejects when service workers are unsupported", async () => {
    vi.stubGlobal("navigator", { serviceWorker: undefined });
    const { ensureStreamSw } = await import("./register");
    await expect(ensureStreamSw()).rejects.toThrow(/unsupported/i);
  });

  it("resolves immediately when a controller already exists", async () => {
    const active = {} as ServiceWorker;
    stubServiceWorker({ controller: active });
    const { ensureStreamSw } = await import("./register");
    await expect(ensureStreamSw()).resolves.toBeUndefined();
  });

  it("registers the dev SW URL in dev and resolves on controllerchange", async () => {
    let changeCb: (() => void) | null = null;
    const sw = stubServiceWorker({
      controller: null,
      addEventListener: vi.fn((_: string, cb: any) => { changeCb = cb; }),
      register: vi.fn().mockImplementation(() => {
        // simulate the registered SW taking control
        (sw as any).controller = {} as ServiceWorker;
        setTimeout(() => changeCb && changeCb(), 0);
        return Promise.resolve({});
      }),
    });
    const { ensureStreamSw } = await import("./register");
    await expect(ensureStreamSw()).resolves.toBeUndefined();
    // vitest runs with import.meta.env.DEV === true, so the dev SW path is used.
    expect(sw.register).toHaveBeenCalledWith("/dev-sw.js?dev-sw", { type: "module" });
  });

  it("registers /sw.js in production builds", async () => {
    vi.stubEnv("DEV", false);
    let changeCb: (() => void) | null = null;
    const sw = stubServiceWorker({
      controller: null,
      addEventListener: vi.fn((_: string, cb: any) => { changeCb = cb; }),
      register: vi.fn().mockImplementation(() => {
        (sw as any).controller = {} as ServiceWorker;
        setTimeout(() => changeCb && changeCb(), 0);
        return Promise.resolve({});
      }),
    });
    const { ensureStreamSw } = await import("./register");
    await expect(ensureStreamSw()).resolves.toBeUndefined();
    expect(sw.register).toHaveBeenCalledWith("/sw.js", { type: "module" });
  });

  it("postToSw forwards to the controller", async () => {
    const post = vi.fn();
    stubServiceWorker({ controller: { postMessage: post } as unknown as ServiceWorker });
    const { postToSw } = await import("./register");
    postToSw({ type: "play" });
    expect(post).toHaveBeenCalledWith({ type: "play" });
  });
});
