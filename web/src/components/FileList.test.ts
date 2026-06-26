import { describe, it, expect } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import FileList from "./FileList.vue";
import { keyOf } from "./fileMenu";
import { i18n } from "@/locales";
import type { FileMeta } from "@/api/types";
import type { Entry } from "./fileMenu";

const global = { plugins: [i18n] } as const;

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
const folderEntry = (id: string, name: string): Entry => ({ kind: "folder", folder: { id, name } });

describe("FileList", () => {
  it("renders grid cards (no list rows) when view='grid'", () => {
    const w = mount(FileList, {
      props: {
        entries: [fileEntry(makeFile({ id: "f1" }))],
        displayNames: {},
        search: "",
        view: "grid",
      },
      global,
    });
    expect(w.findAll("li").length).toBe(0);
    expect(w.text()).toMatch(/f1/);
  });

  it("renders list rows with the folder and file names", () => {
    const w = mount(FileList, {
      props: {
        entries: [folderEntry("d1", "Documents"), fileEntry(makeFile({ id: "f1" }))],
        displayNames: { f1: "report.pdf" },
        search: "",
        view: "list",
      },
      global,
    });
    const rows = w.findAll("li");
    expect(rows.length).toBe(2);
    expect(w.text()).toMatch(/Documents/);
    expect(w.text()).toMatch(/report\.pdf/);
  });

  it("clicking a folder row name emits openFolder; clicking a file name emits openFile", async () => {
    const w = mount(FileList, {
      props: {
        entries: [folderEntry("d1", "Docs"), fileEntry(makeFile({ id: "f1" }))],
        displayNames: {},
        search: "",
        view: "list",
      },
      global,
    });
    const nameButtons = w.findAll("button").filter((b) => b.classes().includes("truncate"));
    expect(nameButtons.length).toBe(2);
    await nameButtons[0].trigger("click");
    expect(w.emitted("openFolder")?.[0]).toEqual(["d1"]);
    await nameButtons[1].trigger("click");
    const ev = w.emitted("openFile");
    expect(ev).toBeTruthy();
    expect((ev![0][0] as FileMeta).id).toBe("f1");
  });

  it("⋯ menu delete item emits deleteFile for a ready file", async () => {
    const e = fileEntry(makeFile({ id: "f1" }));
    const w = mount(FileList, {
      props: { entries: [e], displayNames: {}, search: "", view: "list", selection: [] },
      global,
    });
    const trigger = w.findAll("button").find((b) => b.classes().includes("opacity-0"));
    expect(trigger).toBeTruthy();
    await trigger!.trigger("click");
    await flushPromises();
    const del = w.findAll("button").find((b) => b.text().trim() === "Delete");
    expect(del).toBeTruthy();
    await del!.trigger("click");
    await flushPromises();
    const ev = w.emitted("deleteFile");
    expect(ev).toBeTruthy();
    expect(ev![0][0]).toEqual(e.file);
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
      global,
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
      global,
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
      global,
    });
    const nameBtn = w.findAll("button").find((b) => b.text().trim() === "Name");
    expect(nameBtn).toBeTruthy();
    await nameBtn!.trigger("click");
    expect(w.emitted("update:sortKey")![0][0]).toBe("name");
  });

  it("status sort (asc): folders pin top, then ready < uploading < pending", () => {
    const ready = fileEntry(makeFile({ id: "ready", status: "ready" }));
    const uploading = fileEntry(makeFile({ id: "uploading", status: "uploading" }));
    const pending = fileEntry(makeFile({ id: "pending", status: "pending" }));
    const folder = folderEntry("d1", "Documents");
    const w = mount(FileList, {
      props: {
        entries: [pending, uploading, ready, folder],
        displayNames: {},
        search: "",
        view: "list",
        sortKey: "status",
        sortDir: "asc",
      },
      global,
    });
    const rows = w.findAll("li").map((r) => r.text());
    expect(rows[0]).toMatch(/Documents/);
    expect(rows[1]).toMatch(/ready/);
    expect(rows[2]).toMatch(/uploading/);
    expect(rows[3]).toMatch(/pending/);
  });

  it("status sort (desc) reverses file order but keeps folders on top", () => {
    const ready = fileEntry(makeFile({ id: "ready", status: "ready" }));
    const pending = fileEntry(makeFile({ id: "pending", status: "pending" }));
    const folder = folderEntry("d1", "Documents");
    const w = mount(FileList, {
      props: {
        entries: [ready, pending, folder],
        displayNames: {},
        search: "",
        view: "list",
        sortKey: "status",
        sortDir: "desc",
      },
      global,
    });
    const rows = w.findAll("li").map((r) => r.text());
    expect(rows[0]).toMatch(/Documents/);
    expect(rows[1]).toMatch(/pending/);
    expect(rows[2]).toMatch(/ready/);
  });

  it("renders size and status in separate columns of the list row", () => {
    const w = mount(FileList, {
      props: {
        entries: [fileEntry(makeFile({ id: "f1", total_size: 2048, status: "uploading" }))],
        displayNames: {},
        search: "",
        view: "list",
      },
      global,
    });
    const li = w.find("li");
    expect(li.classes().some((c) => c.includes("grid-cols-[auto_1fr_auto_auto_auto]"))).toBe(true);
    const kids = li.element.children;
    expect(kids.length).toBe(5);
    expect(kids[2].tagName).toBe("SPAN");
    expect(kids[2].textContent).toMatch(/2\.0 KB/);
    expect(kids[3].tagName).toBe("DIV");
    expect(kids[3].textContent).toMatch(/Uploading/);
  });

  it("renders the DfEmpty title when entries is empty", () => {
    const w = mount(FileList, {
      props: { entries: [], displayNames: {}, search: "", view: "list" },
      global,
    });
    expect(w.text()).toMatch(/Nothing here yet/);
    expect(w.findAll("li").length).toBe(0);
  });
});
