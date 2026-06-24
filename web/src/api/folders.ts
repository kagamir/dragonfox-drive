import { http, request } from "./client";
import type {
  CreateFolderRequest,
  DeleteFolderRequest,
  DeleteFolderResponse,
  FolderInfo,
  PatchFolderRequest,
} from "./types";

export const foldersApi = {
  list: () => http.get<{ folders: FolderInfo[] }>("/api/folders"),

  create: (body: CreateFolderRequest) =>
    http.post<{ id: string }>("/api/folders", body),

  patch: (id: string, body: PatchFolderRequest) =>
    http.patch<{ ok: true }>(`/api/folders/${id}`, body),

  remove: (id: string, body: DeleteFolderRequest) =>
    request<DeleteFolderResponse>(`/api/folders/${id}`, { method: "DELETE", body }),
};
