import { describe, it, expect } from "vitest";
import { useConfirm } from "./useConfirm";

describe("useConfirm", () => {
  it("confirm() opens dialog and resolves true on _resolve(true)", async () => {
    const c = useConfirm();
    const p = c.confirm({ message: "删除？" });
    expect(c.state.value.open).toBe(true);
    expect(c.state.value.message).toBe("删除？");
    c._resolve(true);
    expect(await p).toBe(true);
    expect(c.state.value.open).toBe(false);
  });
  it("danger flag defaults false, title default", () => {
    const c = useConfirm();
    c.confirm({ message: "x" });
    expect(c.state.value.danger).toBe(false);
    expect(c.state.value.title).toBeTruthy();
  });
});
