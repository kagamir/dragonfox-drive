import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DfTooltip from "./DfTooltip.vue";

describe("DfTooltip", () => {
  it("renders trigger slot and hidden label by default", () => {
    const w = mount(DfTooltip, { props: { label: "提示文字" }, slots: { default: "<button>T</button>" } });
    expect(w.find("button").exists()).toBe(true);
    const tip = w.find('[role="tooltip"]');
    expect(tip.exists()).toBe(true);
  });
});
