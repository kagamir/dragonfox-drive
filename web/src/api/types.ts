/**
 * Server-side type definitions. These mirror the Rust DTOs in
 * `server/src/api/*.rs` and the SQL schema in
 * `server/migrations/20260101000000_initial.sql`.
 */

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface AuthResponse {
  user_id: string;
  username: string;
  encrypted_master_key: string; // base64
  encrypted_master_key_nonce: string; // base64
  kdf_salt: string; // hex
  tokens: TokenPair;
}

export interface RegisterRequest {
  username: string;
  auth_verifier: string; // hex
  kdf_salt: string; // hex
  server_salt: string; // hex
  encrypted_master_key: string; // base64
  encrypted_master_key_nonce: string; // base64
}

export interface LoginRequest {
  username: string;
  auth_verifier: string; // hex
  device_name?: string;
}

export interface PreloginResponse {
  kdf_salt: string; // hex
  server_salt: string; // hex
}

/** Public runtime config surfaced by `GET /api/config` (no auth required). */
export interface PublicConfig {
  allow_registration: boolean;
}

export interface FileMeta {
  id: string;
  owner_id: string;
  status: "pending" | "uploading" | "ready" | "deleted";
  total_size: number;
  chunk_count: number;
  encrypted_manifest: string | null; // base64
  encrypted_manifest_nonce: string | null; // base64
  encrypted_file_key: string | null; // base64
  encrypted_file_key_nonce: string | null; // base64
  encrypted_parent_id: string | null; // base64; null ≡ root
  encrypted_parent_id_nonce: string | null; // base64
  created_at: string;
  updated_at: string;
}

export interface CreateFileRequest {
  total_size: number;
  chunk_count: number;
  encrypted_file_key: string; // base64
  encrypted_file_key_nonce: string; // base64
  encrypted_parent_id?: string | null; // base64; omit/null ≡ root
  encrypted_parent_id_nonce?: string | null; // base64
}

export interface CreateFileResponse {
  id: string;
  upload_url: string;
}

export interface ShareInfo {
  id: string;
  file_id?: string;
  state?: string; // "active" | "expired" | "exhausted" | "revoked"
  share_salt: string; // base64
  encrypted_file_key: string; // base64
  encrypted_file_key_nonce: string; // base64
  encrypted_manifest?: string; // base64
  encrypted_manifest_nonce?: string; // base64
  requires_password: boolean;
  expires_at: string | null;
}

export interface CreateShareRequest {
  file_id: string;
  share_salt: string;
  encrypted_file_key: string;
  encrypted_file_key_nonce: string;
  password_hash?: string;
  expires_at?: string;
  download_limit?: number;
}

export interface VerifyShareRequest {
  password_verifier: string; // hex
}

export interface VerifyShareResponse {
  state: string;
  encrypted_file_key: string; // base64
  encrypted_file_key_nonce: string; // base64
  encrypted_manifest: string; // base64
  encrypted_manifest_nonce: string; // base64
}

export interface ShareListItem {
  file_id: string;
  id: string;
  state: string;
  requires_password: boolean;
  expires_at: string | null;
  download_limit: number | null;
  download_count: number;
  revoked_at: string | null;
  created_at: string;
}

export interface ChunkIndices {
  indices: number[];
  chunk_count: number;
  status: string;
}

// ---- Folders (P3) -------------------------------------------------------

export interface FolderInfo {
  id: string;
  encrypted_parent_id: string | null; // base64; null ≡ root
  encrypted_parent_id_nonce: string | null; // base64
  encrypted_folder_key: string; // base64
  encrypted_folder_key_nonce: string; // base64
  encrypted_name: string; // base64
  encrypted_name_nonce: string; // base64
  created_at: string;
  updated_at: string;
}

export interface CreateFolderRequest {
  encrypted_parent_id: string | null;
  encrypted_parent_id_nonce: string | null;
  encrypted_folder_key: string;
  encrypted_folder_key_nonce: string;
  encrypted_name: string;
  encrypted_name_nonce: string;
}

/**
 * PATCH folder body. Omitted fields are not updated. To move to root, set
 * encrypted_parent_id + nonce to null AND supply the re-wrapped folder_key.
 * Use `undefined` (not null) for fields you do not want to change.
 */
export interface PatchFolderRequest {
  encrypted_name?: string;
  encrypted_name_nonce?: string;
  encrypted_parent_id?: string | null;
  encrypted_parent_id_nonce?: string | null;
  encrypted_folder_key?: string;
  encrypted_folder_key_nonce?: string;
}

export interface DeleteFolderRequest {
  folder_ids: string[];
  file_ids: string[];
}

export interface DeleteFolderResponse {
  ok: true;
  deleted_folders: number;
  deleted_files: number;
}

export interface PatchFileMoveRequest {
  encrypted_parent_id: string | null;
  encrypted_parent_id_nonce: string | null;
  encrypted_file_key: string;
  encrypted_file_key_nonce: string;
}
