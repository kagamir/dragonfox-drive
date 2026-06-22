import { describe, it, expect } from "vitest";

import { sodium } from "@/crypto";
import { randomBytes } from "@/crypto/kdf";

describe("test environment smoke", () => {
  it("loaded libsodium WASM", () => {
    expect(typeof sodium.crypto_pwhash).toBe("function");
  });

  it("WebCrypto subtle.digest works under happy-dom", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("abc") as BufferSource,
    );
    expect(new Uint8Array(digest).length).toBe(32);
  });

  it("crypto.getRandomValues works", () => {
    const a = randomBytes(16);
    const b = randomBytes(16);
    expect(a.length).toBe(16);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});
