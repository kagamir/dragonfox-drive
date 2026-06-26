import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import FileList from "./FileList.vue";
import { keyOf } from "./fileMenu";
import type { FileMeta } from "@/api/types";
import type { Entry } from "./fileMenu";

function makeFile(overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id: "f1",
    owner_id: "u1",
    status: "ready",
    total_size: 1024,
    chunk_count: 1,
    encrypted_manifest: "m",
    encrypted_manifest_nonce: "mn",
    encrypted_file_key: "k",
    encrypted_file_key_nonce: "kn",
    encrypted_parent_id: null,
    encrypted_parent_id_nonce: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
const fileEntry = (f: FileMeta): Entry => ({ kind: "file", file: f });

describe("FileList", () => {
  it("renders grid cards (no list rows) when view='grid'", () => {
    const w = mount(FileList, {
      props: {
        entries: [fileEntry(makeFile({ id: "f1" }))],
        displayNames: {},
        search: "",
        view: "grid",
      },
    });
    expect(w.findAll("li").length).toBe(0);
    expect(w.text()).toMatch(/f1/);
  });

  it("checkbox toggle emits update:selection with the entry key", async () => {
    const e = fileEntry(makeFile({ id: "f1" }));
    const w = mount(FileList, {
      props: {
        entries: [e],
        displayNames: {},
        search: "",
        view: "list",
        selection: [],
      },
    });
    await w.find('input[type="checkbox"]').trigger("click");
    const ev = w.emitted("update:selection");
    expect(ev).toBeTruthy();
    expect(ev![0][0]).toEqual([keyOf(e)]);
  });

  it("shift-clicking a second checkbox selects the range between", async () => {
    const a = fileEntry(makeFile({ id: "a" }));
    const b = fileEntry(makeFile({ id: "b" }));
    const c = fileEntry(makeFile({ id: "c" }));
    const w = mount(FileList, {
      props: {
        entries: [a, b, c],
        displayNames: {},
        search: "",
        view: "list",
        selection: [],
      },
    });
    const boxes = w.findAll('input[type="checkbox"]');
    await boxes[0].trigger("click");
    await boxes[2].trigger("click", { shiftKey: true });
    const ev = w.emitted("update:selection");
    expect(ev).toBeTruthy();
    expect(ev![1][0]).toEqual([keyOf(a), keyOf(b), keyOf(c)]);
  });

  it("clicking the name column header emits update:sortKey", async () => {
    const w = mount(FileList, {
      props: {
        entries: [fileEntry(makeFile({ id: "f1" }))],
        displayNames: {},
        search: "",
        view: "list",
        sortKey: "size",
      },
    });
    const nameBtn = w.findAll("button").find((b) => b.text().trim() === "名称");
    expect(nameBtn).toBeTruthy();
    await nameBtn!.trigger("click");
    expect(w.emitted("update:sortKey")![0][0]).toBe("name");
  });
});
