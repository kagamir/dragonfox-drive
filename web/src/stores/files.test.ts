import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// `vi.mock` factories are hoisted above all top-level `const`s, so any mock
// function referenced from inside the factory must itself be hoisted via
// `vi.hoisted` — otherwise the factory hits a Temporal Dead Zone reference
// error when the mocked module is imported.
const {
  createMock,
  putManifestMock,
  putChunkMock,
  finalizeMock,
  removeMock,
  getChunkMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  putManifestMock: vi.fn().mockResolvedValue({ ok: true }),
  putChunkMock: vi.fn().mockResolvedValue({ ok: true }),
  finalizeMock: vi.fn().mockResolvedValue({ ok: true }),
  removeMock: vi.fn().mockResolvedValue({ ok: true }),
  getChunkMock: vi.fn().mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3])),
  ),
}));

vi.mock("@/workers/crypto", () => ({
  cryptoApi: {
    encryptFile: vi.fn().mockResolvedValue({
      ciphertext: new Uint8Array([1, 2, 3]),
      encrypted_file_key: "fk",
      encrypted_file_key_nonce: "fkn",
      encrypted_manifest: "em",
      encrypted_manifest_nonce: "emn",
    }),
    decryptFile: vi.fn().mockResolvedValue({
      plaintext: new Uint8Array([9, 9]),
      manifest: { name: "dl.txt", mime: "text/plain", iv_base: "iv==" },
    }),
  },
  ensureCryptoReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/api/files", () => ({
  filesApi: {
    list: vi.fn().mockResolvedValue({ files: [] }),
    create: (b: unknown) => {
      createMock(b);
      return Promise.resolve({ id: "fid", upload_url: "/x" });
    },
    putManifest: putManifestMock,
    putChunk: putChunkMock,
    finalize: finalizeMock,
    remove: removeMock,
    getChunk: getChunkMock,
  },
}));

import { cryptoApi } from "@/workers/crypto";
import { useFilesStore } from "./files";
import { useAuthStore } from "./auth";

describe("files store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    createMock.mockClear();
    putManifestMock.mockClear();
    putChunkMock.mockClear();
    finalizeMock.mockClear();
    removeMock.mockClear();
  });

  it("upload calls create → putManifest → putChunk → finalize in order", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    const file = new File([new Uint8Array([7, 7])], "u.txt", {
      type: "text/plain",
    });
    await files.upload(file);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ total_size: 2, chunk_count: 1 }),
    );
    expect(putManifestMock).toHaveBeenCalledWith("fid", expect.any(Object));
    expect(putChunkMock).toHaveBeenCalledWith(
      "fid", 0, expect.any(Uint8Array), expect.any(Function),
    );
    expect(finalizeMock).toHaveBeenCalledWith("fid");
  });

  it("remove calls the api and refreshes", async () => {
    const files = useFilesStore();
    await files.remove("x");
    expect(removeMock).toHaveBeenCalledWith("x");
  });

  it("download fetches the chunk and decrypts it", async () => {
    const auth = useAuthStore();
    auth.masterKey = new Uint8Array(32) as any;
    const files = useFilesStore();
    // jsdom lacks URL.createObjectURL
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    const meta = {
      id: "f1", owner_id: "u", status: "ready" as const,
      total_size: 2, chunk_count: 1,
      encrypted_manifest: "em", encrypted_manifest_nonce: "emn",
      encrypted_file_key: "fk", encrypted_file_key_nonce: "fkn",
      created_at: "", updated_at: "",
    };
    await files.download(meta);
    expect(getChunkMock).toHaveBeenCalledWith("f1", 0);
    expect(cryptoApi.decryptFile).toHaveBeenCalled();
  });
});
