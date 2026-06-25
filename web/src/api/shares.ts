import { http, request } from "./client";
import type {
  CreateShareRequest,
  ShareInfo,
  ShareListItem,
  VerifyShareRequest,
  VerifyShareResponse,
} from "./types";

export const sharesApi = {
  create: (body: CreateShareRequest) =>
    http.post<{ id: string }>("/api/shares", body),

  listForFile: (fileId: string) =>
    http.get<{ shares: ShareListItem[] }>(`/api/shares?file_id=${encodeURIComponent(fileId)}`),

  get: (id: string) => http.get<ShareInfo>(`/api/shares/${id}`),

  verify: (id: string, body: VerifyShareRequest) =>
    http.post<VerifyShareResponse>(`/api/shares/${id}/verify`, body),

  revoke: (id: string) => http.delete<{ ok: true }>(`/api/shares/${id}`),

  /** Fetch a single encrypted chunk (public). */
  getChunk: (id: string, index: number, signal?: AbortSignal) =>
    request<Response>(`/api/shares/${id}/chunks/${index}`, {
      method: "GET",
      rawResponse: true,
      signal,
    }),
};
