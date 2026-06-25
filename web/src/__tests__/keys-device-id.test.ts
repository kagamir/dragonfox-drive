import { beforeEach, describe, expect, it } from "vitest";

// `setup.ts` already mocks `localforage` globally with an in-memory Map.
// We import the real `keys.ts` and rely on that mock; the shared store is
// reset between tests by calling `clearDeviceWrap` (which removes
// KEY_USER_ID, KEY_DEVICE_WRAP and KEY_DEVICE_ID).
import {
  persistDeviceId,
  loadDeviceId,
  clearDeviceId,
  clearDeviceWrap,
} from "../crypto/keys";

describe("device_id persistence", () => {
  beforeEach(async () => {
    await clearDeviceWrap();
  });

  it("persists and reloads device_id", async () => {
    await persistDeviceId("u1", "dev-1");
    expect(await loadDeviceId()).toBe("dev-1");
  });

  it("returns null when nothing persisted", async () => {
    expect(await loadDeviceId()).toBeNull();
  });

  it("clearDeviceId removes only the device_id entry", async () => {
    await persistDeviceId("u1", "dev-1");
    await clearDeviceId();
    expect(await loadDeviceId()).toBeNull();
  });

  it("clearDeviceWrap also removes device_id (used on logout)", async () => {
    await persistDeviceId("u1", "dev-1");
    await clearDeviceWrap();
    expect(await loadDeviceId()).toBeNull();
  });
});
