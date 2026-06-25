import { describe, it, expect, beforeEach, vi } from "vitest";
import { useToast } from "./useToast";

describe("useToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToast().clear(); // 清空单例
  });

  it("success pushes a toast", () => {
    const t = useToast();
    t.success("已上传");
    expect(t.items.value).toHaveLength(1);
    expect(t.items.value[0].type).toBe("success");
  });

  it("auto-removes after duration", () => {
    const t = useToast();
    t.success("x", 1000);
    expect(t.items.value).toHaveLength(1);
    vi.advanceTimersByTime(1100);
    expect(t.items.value).toHaveLength(0);
  });

  it("remove(id) drops specific toast", () => {
    const t = useToast();
    const id = t.info("a", 0);
    t.remove(id);
    expect(t.items.value).toHaveLength(0);
  });
});
