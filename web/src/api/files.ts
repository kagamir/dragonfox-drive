import { http, request } from "./client";
import type { CreateFileRequest, CreateFileResponse, FileMeta } from "./types";

export const filesApi = {
  list: () => http.get<{ files: FileMeta[] }>("/api/files"),

  create: (body: CreateFileRequest) =>
    http.post<CreateFileResponse>("/api/files", body),

  getManifest: (id: string) =>
    http.get<{ encrypted_manifest: string; encrypted_manifest_nonce: string }>(
      `/api/files/${id}/manifest`,
    ),

  putManifest: (
    id: string,
    body: { encrypted_manifest: string; encrypted_manifest_nonce: string },
  ) => http.put<{ ok: true }>(`/api/files/${id}/manifest`, body),

  /** Upload a single encrypted chunk via multipart/form-data. */
  putChunk: (
    id: string,
    index: number,
    ciphertext: Uint8Array,
    signal?: AbortSignal,
  ) => {
    const form = new FormData();
    form.append("chunk", new Blob([ciphertext as BlobPart]));
    return request<{ ok: true }>(`/api/files/${id}/chunks/${index}`, {
      method: "PUT",
      rawBody: form,
      signal,
    });
  },

  /** Fetch a single encrypted chunk. */
  getChunk: (id: string, index: number, signal?: AbortSignal) =>
    request<Response>(`/api/files/${id}/chunks/${index}`, {
      method: "GET",
      rawResponse: true,
      signal,
    }),

  finalize: (id: string) => http.post<{ ok: true }>(`/api/files/${id}/finalize`),

  remove: (id: string) => http.delete<{ ok: true }>(`/api/files/${id}`),
};
