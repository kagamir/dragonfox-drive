import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import type { FileMeta } from "@/api/types";
import FileThumbnail from "./FileThumbnail.vue";

const load = vi.hoisted(() => vi.fn());
const auth = reactive({ userId: "u", masterKey: new Uint8Array(32) as Uint8Array | null, isAuthenticated: true });
vi.mock("@/stores/auth", () => ({ useAuthStore: () => auth }));
vi.mock("@/stores/files", () => ({ useFilesStore: () => ({ displayMimes: { f: "image/png" } }) }));
vi.mock("@/stores/thumbnails", () => ({
  thumbnailMime: () => "image/png", useThumbnailsStore: () => ({ load }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("loads only near the viewport, releases URLs on exit and ignores stale results after locking", async () => {
  let enter: (nearby: boolean) => void;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      enter = (isIntersecting) => callback([{ isIntersecting }]);
    }
    observe() {}
    disconnect() {}
  });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  load.mockResolvedValueOnce(new Blob(["photo"]));
  const w = mount(FileThumbnail, { props: { file: { id: "f", status: "ready" } as FileMeta, name: "sample.png" } });
  expect(load).not.toHaveBeenCalled();
  enter!(true);
  await flushPromises();
  expect(w.get("img").attributes("src")).toBe("blob:test");
  enter!(false);
  await flushPromises();
  expect(revoke).toHaveBeenCalledWith("blob:test");
  expect(w.find("img").exists()).toBe(false);
  let finish!: (blob: Blob) => void;
  load.mockImplementationOnce(() => new Promise<Blob>((r) => { finish = r; })).mockResolvedValue(null);
  enter!(true);
  auth.isAuthenticated = false;
  finish(new Blob(["outdated"]));
  await flushPromises();
  expect(create).toHaveBeenCalledTimes(1);
  expect(w.find("img").exists()).toBe(false);
  w.unmount();
});
