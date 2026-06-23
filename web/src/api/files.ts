import { http } from "./client";
import { getAuthToken, ApiError, request } from "./client";
import type { CreateFileRequest, CreateFileResponse, FileMeta, ChunkIndices } from "./types";

export const filesApi = {
  list: () => http.get<{ files: FileMeta[] }>("/api/files"),

  create: (body: CreateFileRequest) =>
    http.post<CreateFileResponse>("/api/files", body),

  getManifest: (id: string) =>
    http.get<{ encrypted_manifest: string; encrypted_manifest_nonce: string }>(
      `/api/files/${id}/manifest`,
    ),

  /** Query which chunk indices are already on the server (upload resume). */
  getChunks: (id: string) =>
    http.get<ChunkIndices>(`/api/files/${id}/chunks`),

  putManifest: (
    id: string,
    body: { encrypted_manifest: string; encrypted_manifest_nonce: string },
  ) => http.put<{ ok: true }>(`/api/files/${id}/manifest`, body),

  /**
   * Upload a single encrypted chunk as a raw octet-stream body with
   * upload-progress reporting. Uses XHR (fetch has no upload-progress API).
   * On 401 the caller is expected to refresh and retry (same as other
   * endpoints; the short upload window rarely crosses token expiry).
   */
  putChunk: (
    id: string,
    index: number,
    ciphertext: Uint8Array,
    onProgress?: (ratio: number) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: true }> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/files/${id}/chunks/${index}`);
      const token = getAuthToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      if (signal) {
        signal.addEventListener("abort", () => {
          xhr.abort();
          reject(new ApiError("upload aborted", 0));
        });
      }
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true });
        else {
          reject(
            new ApiError(xhr.statusText || `HTTP ${xhr.status}`, xhr.status),
          );
        }
      };
      xhr.onerror = () => reject(new ApiError("network error", 0));
      xhr.send(ciphertext);
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
