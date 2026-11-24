import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "./auth";
import { useThumbnailsStore, thumbnailMime } from "./thumbnails";
import { FILE_CHUNK_SIZE } from "@/crypto/file";
import { PREVIEW_CAPS } from "@/crypto/preview";
import type { FileMeta } from "@/api/types";

const stubs = vi.hoisted(() => ({
  unlock: vi.fn(), fetch: vi.fn(), decrypt: vi.fn(), embedded: vi.fn(), resize: vi.fn(),
}));
vi.mock("./files", () => ({ useFilesStore: () => ({ unlockFile: stubs.unlock }) }));
vi.mock("@/api/files", () => ({ filesApi: { getChunk: stubs.fetch } }));
vi.mock("@/workers/crypto", () => ({ cryptoApi: { decryptChunk: stubs.decrypt } }));
vi.mock("@/util/photoThumbnail", () => ({ embeddedJpeg: stubs.embedded, resizePhoto: stubs.resize }));

function fixture(size: number, mime: string) {
  const meta = { id: "photo", status: "ready", owner_id: "user", encrypted_manifest_nonce: "n",
    total_size: size, chunk_count: Math.ceil(size / FILE_CHUNK_SIZE) } as FileMeta;
  stubs.unlock.mockResolvedValue({ fileKey: new Uint8Array(32), manifest: {
    name: "photo.jpg", size, mime, iv_base: "", content_id: "cid", chunk_size: FILE_CHUNK_SIZE,
  } });
  stubs.fetch.mockImplementation(async (_id, index) => new Response(new Uint8Array(Math.min(size - index * FILE_CHUNK_SIZE, FILE_CHUNK_SIZE) + 16)));
  stubs.decrypt.mockResolvedValue(new Uint8Array([42]));
  stubs.embedded.mockResolvedValue(null);
  stubs.resize.mockResolvedValue(new Blob(["thumbnail"]));
  return meta;
}
beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  useAuthStore().$patch({ userId: "user", isAuthenticated: true, masterKey: new Uint8Array(32) });
});

describe("local thumbnails", () => {
  it("uses the shared media type and offers supported image formats to the rasterizer", () => {
    expect(thumbnailMime(undefined, "PIC.JPEG")).toBe("image/jpeg");
    expect(thumbnailMime("binary/octet-stream", "pic.png")).toBe("image/png");
    expect(thumbnailMime("application/pdf", "pic.png")).toBeNull();
    expect(thumbnailMime("text/html", "drawing.svg")).toBeNull();
    expect(thumbnailMime("image/svg+xml", "drawing.svg")).toBe("image/svg+xml");
    expect(thumbnailMime("application/octet-stream", "burst.APNG")).toBe("image/apng");
    expect(thumbnailMime("", "icon.ico")).toBe("image/vnd.microsoft.icon");
    expect(thumbnailMime("image/x-icon", "icon.bin")).toBe("image/x-icon");
    expect(thumbnailMime(undefined, "landscape.jxl")).toBe("image/jxl");
    expect(thumbnailMime(undefined, "camera.dng")).toBeNull();
  });
  it("uses only the authenticated first chunk for a large JPEG with an embedded thumbnail", async () => {
    const meta = fixture(38 * 1024 * 1024, "image/jpeg");
    const embedded = new Blob(["embedded"], { type: "image/jpeg" });
    stubs.embedded.mockResolvedValue(embedded);
    const signal = new AbortController().signal;
    expect(await useThumbnailsStore().load(meta, signal)).toBeInstanceOf(Blob);
    expect(stubs.resize).toHaveBeenCalledWith(embedded, signal);
    expect(stubs.fetch).toHaveBeenCalledTimes(1);
    expect(stubs.fetch).toHaveBeenCalledWith(meta.id, 0, signal);
  });
  it.each(["image/jpeg", "image/png"])("reads a 17 MiB %s without an embedded thumbnail in order", async (mime) => {
    const meta = fixture(17 * 1024 * 1024, mime);
    const signal = new AbortController().signal;
    expect(await useThumbnailsStore().load(meta, signal)).toBeInstanceOf(Blob);
    expect(stubs.fetch.mock.calls.map((args) => args[1])).toEqual([0, 1, 2, 3, 4]);
    expect(stubs.resize.mock.calls[0][0].type).toBe(mime);
  });
  it("honours the full-image cap and only checks the first chunk for an oversize JPEG", async () => {
    const store = useThumbnailsStore();
    const signal = new AbortController().signal;
    const size = PREVIEW_CAPS.image + 1;
    expect(await store.load(fixture(size, "image/png"), signal)).toBeNull();
    expect(stubs.fetch).not.toHaveBeenCalled();
    expect(await store.load({ ...fixture(size, "image/jpeg"), id: "jpeg" }, signal)).toBeNull();
    expect(stubs.fetch).toHaveBeenCalledTimes(1);
    expect(stubs.resize).not.toHaveBeenCalled();
  });
  it("cancels queued large originals without requesting a chunk", async () => {
    const store = useThumbnailsStore();
    const active = new AbortController();
    const queued = new AbortController();
    const meta = fixture(17 * 1024 * 1024, "image/png");
    let finish!: (blob: Blob) => void;
    stubs.resize.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = store.load(meta, active.signal);
    const waiting = store.load({ ...meta, id: "queued" }, queued.signal);
    queued.abort();
    await expect(waiting).rejects.toBeDefined();
    await vi.waitFor(() => expect(stubs.resize).toHaveBeenCalledTimes(1));
    finish(new Blob(["thumbnail"]));
    await first;
    expect(stubs.fetch.mock.calls.every((args) => args[0] === "photo")).toBe(true);
  });
  it("reuses the local thumbnail until the manifest or unlocked session changes", async () => {
    const meta = fixture(3, "image/jpeg");
    const store = useThumbnailsStore();
    const signal = new AbortController().signal;
    const first = await store.load(meta, signal);
    expect(await store.load(meta, signal)).toBe(first);
    expect(stubs.fetch).toHaveBeenCalledTimes(1);
    await store.load({ ...meta, encrypted_manifest_nonce: "new" }, signal);
    useAuthStore().$patch({ masterKey: null, isAuthenticated: false });
    expect(await store.load(meta, signal)).toBeNull();
    useAuthStore().$patch({ masterKey: new Uint8Array(32), isAuthenticated: true });
    await store.load(meta, signal);
    expect(stubs.fetch).toHaveBeenCalledTimes(3);
  });
});
