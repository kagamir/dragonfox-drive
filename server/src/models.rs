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
