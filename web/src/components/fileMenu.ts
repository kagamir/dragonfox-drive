import type { FileMeta } from "@/api/types";
import type { DropdownItem } from "@/components/ui/DfDropdown.vue";
import {
  Download, Share2, Pencil, FolderInput, Trash2, FolderOpen,
} from "lucide-vue-next";

export type Entry =
  | { kind: "folder"; folder: { id: string; name: string } }
  | { kind: "file"; file: FileMeta };

export type SortKey = "name" | "size" | "status";

export interface MenuHandlers {
  openFolder: (id: string) => void;
  openFile: (f: FileMeta) => void;
  download: (f: FileMeta) => void;
  share: (f: FileMeta) => void;
  renameFolder: (id: string, name: string) => void;
  moveFolder: (id: string) => void;
  moveFile: (id: string) => void;
  deleteFolder: (id: string, name: string) => void;
  deleteFile: (f: FileMeta) => void;
}

export function keyOf(e: Entry): string {
  return e.kind + (e.kind === "folder" ? e.folder.id : e.file.id);
}

export function parseKey(k: string): { kind: "folder" | "file"; id: string } {
  if (k.startsWith("folder")) return { kind: "folder", id: k.slice("folder".length) };
  return { kind: "file", id: k.slice("file".length) };
}

export function menuFor(e: Entry, h: MenuHandlers): DropdownItem[] {
  if (e.kind === "folder") {
    return [
      { label: "重命名", icon: Pencil, onClick: () => h.renameFolder(e.folder.id, e.folder.name) },
      { label: "移动", icon: FolderInput, onClick: () => h.moveFolder(e.folder.id) },
      { label: "删除", icon: Trash2, danger: true, onClick: () => h.deleteFolder(e.folder.id, e.folder.name) },
    ];
  }
  const f = e.file;
  return [
    { label: "打开", icon: FolderOpen, onClick: () => h.openFile(f), disabled: f.status !== "ready" },
    { label: "下载", icon: Download, onClick: () => h.download(f), disabled: f.status !== "ready" },
    { label: "分享", icon: Share2, onClick: () => h.share(f), disabled: f.status !== "ready" },
    { label: "移动", icon: FolderInput, onClick: () => h.moveFile(f.id) },
    { label: "删除", icon: Trash2, danger: true, onClick: () => h.deleteFile(f) },
  ];
}
