import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { bytes, shortString } from "@/__tests__/fc-arbitrary";
import {
  normaliseUsername,
  usernameToSalt,
  derivePasswordKey,
  deriveAuthVerifier,
  deriveSubkey,
  randomBytes,
  KEY_BYTES,
} from "./kdf";

describe("normaliseUsername", () => {
  it("trims and lowercases", () => {
    expect(normaliseUsername("  Alice ")).toBe("alice");
  });
  it("is idempotent", () => {
    const once = normaliseUsername("Bob");
    expect(normaliseUsername(once)).toBe(once);
  });
});

describe("usernameToSalt", () => {
  it("is deterministic", async () => {
    expect(Array.from(await usernameToSalt("alice"))).toEqual(
      Array.from(await usernameToSalt("alice")),
    );
  });
  it("produces 16 bytes", async () => {
    expect((await usernameToSalt("alice")).length).toBe(16);
  });
  it("differs for different usernames", async () => {
    expect(Array.from(await usernameToSalt("alice"))).not.toEqual(
      Array.from(await usernameToSalt("bob")),
    );
  });
});

describe("derivePasswordKey", () => {
  it("is deterministic", async () => {
    expect(Array.from(await derivePasswordKey("pw", "alice"))).toEqual(
      Array.from(await derivePasswordKey("pw", "alice")),
    );
  });
  it("produces 32 bytes", async () => {
    expect((await derivePasswordKey("pw", "alice")).length).toBe(KEY_BYTES);
  });
  it("differs for different passwords", async () => {
    expect(Array.from(await derivePasswordKey("pw1", "alice"))).not.toEqual(
      Array.from(await derivePasswordKey("pw2", "alice")),
    );
  });
  it("differs for different usernames", async () => {
    expect(Array.from(await derivePasswordKey("pw", "alice"))).not.toEqual(
      Array.from(await derivePasswordKey("pw", "bob")),
    );
  });
});

describe("deriveAuthVerifier", () => {
  it("is deterministic for the same inputs", () => {
    const key = randomBytes(32);
    const salt = randomBytes(16);
    expect(Array.from(deriveAuthVerifier(key, salt))).toEqual(
      Array.from(deriveAuthVerifier(key, salt)),
    );
  });
  it("produces 32 bytes", () => {
    expect(deriveAuthVerifier(randomBytes(32), randomBytes(16)).length).toBe(KEY_BYTES);
  });
  it("differs for different server salts", () => {
    const key = randomBytes(32);
    expect(Array.from(deriveAuthVerifier(key, randomBytes(16)))).not.toEqual(
      Array.from(deriveAuthVerifier(key, randomBytes(16))),
    );
  });
});

describe("deriveSubkey", () => {
  it("is deterministic", async () => {
    const master = randomBytes(32);
    expect(Array.from(await deriveSubkey(master, "info-a"))).toEqual(
      Array.from(await deriveSubkey(master, "info-a")),
    );
  });
  it("differs for different info strings", async () => {
    const master = randomBytes(32);
    expect(Array.from(await deriveSubkey(master, "info-a"))).not.toEqual(
      Array.from(await deriveSubkey(master, "info-b")),
    );
  });
  it("honours the length argument", async () => {
    const master = randomBytes(32);
    expect((await deriveSubkey(master, "x", 16)).length).toBe(16);
    expect((await deriveSubkey(master, "x", 64)).length).toBe(64);
  });
});

describe("deriveSubkey [property]", () => {
  it("is deterministic for random (master, info)", () => {
    return fc.assert(
      fc.asyncProperty(
        bytes(32, 32),
        shortString(32),
        async (masterBytes, info) => {
          const master = new Uint8Array(masterBytes);
          const a = await deriveSubkey(master, info);
          const b = await deriveSubkey(master, info);
          return Array.from(a).every((v, i) => v === b[i]);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("randomBytes", () => {
  it("returns the requested length", () => {
    expect(randomBytes(0).length).toBe(0);
    expect(randomBytes(1).length).toBe(1);
    expect(randomBytes(1024).length).toBe(1024);
  });
});

describe("randomBytes [property]", () => {
  it("two consecutive calls are distinct", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1024 }), (n) => {
        const a = randomBytes(n);
        const b = randomBytes(n);
        return Array.from(a).some((v, i) => v !== b[i]);
      }),
      { numRuns: 50 },
    );
  });
});
