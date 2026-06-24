//! Database row models (sqlx::FromRow).

#[derive(Debug, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub username: String,
    pub kdf_salt: String,
    pub server_salt: String,
    pub verifier_hash: String,
    pub encrypted_master_key: String,
    pub encrypted_master_key_nonce: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
pub struct FileRow {
    pub id: String,
    pub owner_id: String,
    pub status: String,
    pub total_size: i64,
    pub chunk_count: i32,
    pub encrypted_manifest: Option<String>,
    pub encrypted_manifest_nonce: Option<String>,
    pub encrypted_file_key: Option<String>,
    pub encrypted_file_key_nonce: Option<String>,
    pub encrypted_parent_id: Option<String>,
    pub encrypted_parent_id_nonce: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
pub struct FolderRow {
    pub id: String,
    pub owner_id: String,
    pub encrypted_parent_id: Option<String>,
    pub encrypted_parent_id_nonce: Option<String>,
    pub encrypted_folder_key: String,
    pub encrypted_folder_key_nonce: String,
    pub encrypted_name: String,
    pub encrypted_name_nonce: String,
    pub created_at: String,
    pub updated_at: String,
}
