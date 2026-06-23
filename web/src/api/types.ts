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
  created_at: string;
  updated_at: string;
}

export interface CreateFileRequest {
  total_size: number;
  chunk_count: number;
  encrypted_file_key: string; // base64
  encrypted_file_key_nonce: string; // base64
}

export interface CreateFileResponse {
  id: string;
  upload_url: string;
}

export interface ShareInfo {
  id: string;
  file_id: string;
  share_salt: string; // hex
  encrypted_file_key: string; // base64
  encrypted_file_key_nonce: string; // base64
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

export interface ChunkIndices {
  indices: number[];
  chunk_count: number;
  status: string;
}
