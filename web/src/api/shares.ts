import { http } from "./client";
import type { CreateShareRequest, ShareInfo } from "./types";

export const sharesApi = {
  create: (body: CreateShareRequest) =>
    http.post<{ id: string }>("/api/shares", body),

  get: (id: string) => http.get<ShareInfo>(`/api/shares/${id}`),

  revoke: (id: string) => http.delete<{ ok: true }>(`/api/shares/${id}`),
};
