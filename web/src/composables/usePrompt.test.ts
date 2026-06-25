import { describe, it, expect } from "vitest";
import { usePrompt } from "./usePrompt";
describe("usePrompt", () => {
  it("opens with initial value and returns submitted string", async () => {
    const p = usePrompt();
    const r = p.prompt({ message: "名称", initial: "新建文件夹" });
    expect(p.state.value.open).toBe(true);
    expect(p.state.value.initial).toBe("新建文件夹");
    p._submit("工作");
    expect(await r).toBe("工作");
  });
  it("cancel resolves null", async () => {
    const p = usePrompt();
    const r = p.prompt({ message: "x" });
    p._submit(null);
    expect(await r).toBeNull();
  });
});
