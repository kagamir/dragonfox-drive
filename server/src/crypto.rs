//! Server-side hashing primitives.
//!
//! The server never sees the user's password. It receives a client-derived
//! `auth_verifier` (itself an Argon2id output) and hashes it again with the
//! user's `server_salt` before storage. This adds a third Argon2id layer so
//! that a DB leak still requires per-candidate triple Argon2id to crack.

use anyhow::{ensure, Context, Result};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use sha2::{Digest, Sha256};

/// Hash a client-derived `auth_verifier` (hex) with `server_salt` (hex) using
/// Argon2id (crate defaults: m=19456 KiB, t=2, p=1). Returns a PHC string that
/// embeds the salt and parameters.
pub fn hash_verifier(auth_verifier_hex: &str, server_salt_hex: &str) -> Result<String> {
    let verifier = hex::decode(auth_verifier_hex).context("auth_verifier is not valid hex")?;
    let salt_bytes = hex::decode(server_salt_hex).context("server_salt is not valid hex")?;
    // Argon2 requires a salt of 8..=64 bytes; SaltString::encode_b64 panics
    // (TooShort) below this minimum, so guard explicitly to avoid a server
    // panic on malformed/malicious input.
    ensure!(
        (argon2::MIN_SALT_LEN..=argon2::MAX_SALT_LEN).contains(&salt_bytes.len()),
        "server_salt must be {}..={} bytes, got {}",
        argon2::MIN_SALT_LEN,
        argon2::MAX_SALT_LEN,
        salt_bytes.len()
    );
    let salt = SaltString::encode_b64(&salt_bytes).context("encoding server salt as b64")?;
    let phc = Argon2::default()
        .hash_password(&verifier, &salt)
        .context("argon2 hashing of auth_verifier failed")?;
    Ok(phc.to_string())
}

/// Verify a client-derived `auth_verifier` (hex) against a stored PHC string.
/// Reads parameters back out of the PHC, so the same default instance verifies
/// hashes it issued.
pub fn verify_verifier(auth_verifier_hex: &str, phc: &str) -> Result<bool> {
    let verifier = hex::decode(auth_verifier_hex).context("auth_verifier is not valid hex")?;
    let parsed = PasswordHash::new(phc).context("parsing stored verifier hash")?;
    Ok(Argon2::default().verify_password(&verifier, &parsed).is_ok())
}

/// SHA-256 hex of a refresh-token JWT, for the `refresh_tokens.token_hash` column.
pub fn hash_refresh_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT_HEX: &str = "00112233445566778899aabbccddeeff";
    const VERIFIER_HEX: &str =
        "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const ZERO_VERIFIER_HEX: &str =
        "0000000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn hash_and_verify_round_trip() {
        let phc = hash_verifier(VERIFIER_HEX, SALT_HEX).unwrap();
        assert!(verify_verifier(VERIFIER_HEX, &phc).unwrap());
    }

    #[test]
    fn verify_rejects_a_different_verifier() {
        let phc = hash_verifier(VERIFIER_HEX, SALT_HEX).unwrap();
        assert!(!verify_verifier(ZERO_VERIFIER_HEX, &phc).unwrap());
    }

    #[test]
    fn different_server_salt_yields_different_phc() {
        let other_salt = "ffeeddccbbaa99887766554433221100";
        let a = hash_verifier(VERIFIER_HEX, SALT_HEX).unwrap();
        let b = hash_verifier(VERIFIER_HEX, other_salt).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn hash_refresh_token_is_deterministic_distinct_and_hex() {
        let h1 = hash_refresh_token("token-abc");
        let h2 = hash_refresh_token("token-abc");
        assert_eq!(h1, h2);
        assert_ne!(h1, hash_refresh_token("token-xyz"));
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn hash_verifier_rejects_an_overshort_salt_without_panicking() {
        // A 1-byte salt would otherwise panic inside SaltString::encode_b64
        // (TooShort invariant); it must return an Err instead.
        let res = hash_verifier(VERIFIER_HEX, "ff");
        assert!(res.is_err());
    }
}
