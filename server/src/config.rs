//! Strongly-typed configuration loaded from `config.toml` and environment.

use std::path::PathBuf;

use anyhow::{Context, Result};
use config::{Config, ConfigError, File, Environment};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Settings {
    pub server: ServerSettings,
    pub storage: StorageSettings,
    pub database: DatabaseSettings,
    pub jwt: JwtSettings,
    pub limits: LimitSettings,
    pub security: SecuritySettings,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct ServerSettings {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct StorageSettings {
    pub data_dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct DatabaseSettings {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct JwtSettings {
    pub secret: String,
    pub access_ttl_seconds: i64,
    pub refresh_ttl_seconds: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct LimitSettings {
    pub max_file_bytes: u64,
    pub max_chunk_bytes: u64,
    pub rate_limit_per_minute: u32,
}

/// Policy flags controlling who may use the API.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct SecuritySettings {
    /// Whether `POST /api/auth/register` accepts new accounts. Set to `false`
    /// to lock the instance down after the operator has created their account.
    pub allow_registration: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: ServerSettings::default(),
            storage: StorageSettings::default(),
            database: DatabaseSettings::default(),
            jwt: JwtSettings::default(),
            limits: LimitSettings::default(),
            security: SecuritySettings::default(),
        }
    }
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".into(),
            port: 8080,
        }
    }
}

impl Default for StorageSettings {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("./data"),
        }
    }
}

impl Default for DatabaseSettings {
    fn default() -> Self {
        Self {
            url: "sqlite://./data/dragonfox.db?mode=rwc".into(),
        }
    }
}

impl Default for JwtSettings {
    fn default() -> Self {
        Self {
            // Overwritten by `Settings::load()` with a freshly generated random
            // value; `Default` only seeds tests, which set their own secret.
            secret: String::new(),
            access_ttl_seconds: 900,
            refresh_ttl_seconds: 2_592_000,
        }
    }
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            allow_registration: true,
        }
    }
}

/// Generate a 256-bit JWT signing secret as hex. The secret is not configurable
/// — it is regenerated on every startup, which invalidates all previously issued
/// access/refresh tokens (every user must sign in again after a restart).
fn generate_jwt_secret() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

impl Default for LimitSettings {
    fn default() -> Self {
        Self {
            max_file_bytes: 100 * 1024 * 1024 * 1024,
            max_chunk_bytes: 8 * 1024 * 1024,
            rate_limit_per_minute: 600,
        }
    }
}

impl Settings {
    /// Load settings from `config.toml` first, then override with `DRAGONFOX__` env vars
    /// (double underscore separates sections, e.g. `DRAGONFOX__SERVER__PORT=9000`).
    pub fn load() -> Result<Self> {
        let builder = Config::builder()
            .add_source(File::with_name("config.toml").required(false))
            .add_source(
                Environment::with_prefix("DRAGONFOX")
                    .prefix_separator("__")
                    .separator("__")
                    .try_parsing(true),
            );

        let settings = builder
            .build()
            .map_err(|e| map_config_err(e))
            .context("building configuration")?;

        let mut settings = settings
            .try_deserialize::<Settings>()
            .map_err(|e| map_config_err(e))
            .context("deserializing configuration")?;

        // The JWT secret is never read from config/env: always overwrite it with
        // a freshly generated random value so the signing key is unguessable and
        // rotates on every process start.
        settings.jwt.secret = generate_jwt_secret();

        Ok(settings)
    }
}

fn map_config_err(e: ConfigError) -> anyhow::Error {
    anyhow::anyhow!(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_documented_values() {
        let s = Settings::default();
        assert_eq!(s.server.host, "0.0.0.0");
        assert_eq!(s.server.port, 8080);
        assert_eq!(s.storage.data_dir, std::path::PathBuf::from("./data"));
        assert_eq!(s.database.url, "sqlite://./data/dragonfox.db?mode=rwc");
        assert_eq!(s.jwt.access_ttl_seconds, 900);
        assert_eq!(s.jwt.refresh_ttl_seconds, 2_592_000);
        assert_eq!(s.limits.max_file_bytes, 100 * 1024 * 1024 * 1024);
        assert_eq!(s.limits.max_chunk_bytes, 8 * 1024 * 1024);
        assert_eq!(s.limits.rate_limit_per_minute, 600);
        assert!(
            s.security.allow_registration,
            "registration must be open by default"
        );
    }

    #[test]
    fn jwt_secret_is_not_configurable_and_starts_empty_in_default() {
        // `Default` seeds an empty secret; only `Settings::load()` generates one.
        assert!(Settings::default().jwt.secret.is_empty());
    }

    /// WARNING: mutates process CWD and env. Run the suite with --test-threads=1.
    #[test]
    fn load_merges_toml_file_and_env_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let original_cwd = std::env::current_dir().unwrap();

        struct Restore {
            cwd: std::path::PathBuf,
        }
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = std::env::set_current_dir(&self.cwd);
                std::env::remove_var("DRAGONFOX__SERVER__HOST");
            }
        }
        let _guard = Restore {
            cwd: original_cwd.clone(),
        };

        std::fs::write(
            dir.path().join("config.toml"),
            "[server]\nport = 9999\nhost = \"0.0.0.0\"\n",
        )
        .unwrap();
        std::env::set_current_dir(dir.path()).unwrap();
        std::env::set_var("DRAGONFOX__SERVER__HOST", "127.0.0.1");

        let settings = Settings::load().unwrap();

        assert_eq!(settings.server.port, 9999);
        assert_eq!(settings.server.host, "127.0.0.1");
    }

    /// Regression guard: a `[limits]` section in config.toml MUST override the
    /// code defaults. A stale `0` body limit previously collapsed the
    /// router-wide `DefaultBodyLimit` to zero, returning 413 for every request
    /// body. WARNING: mutates CWD — run the suite with --test-threads=1.
    #[test]
    fn load_lets_toml_override_limits() {
        let dir = tempfile::tempdir().unwrap();
        let original_cwd = std::env::current_dir().unwrap();
        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = std::env::set_current_dir(&self.0);
            }
        }
        let _guard = Restore(original_cwd);

        std::fs::write(
            dir.path().join("config.toml"),
            "[limits]\nmax_file_bytes = 42\nmax_chunk_bytes = 7\n",
        )
        .unwrap();
        std::env::set_current_dir(dir.path()).unwrap();

        let settings = Settings::load().unwrap();
        assert_eq!(settings.limits.max_file_bytes, 42);
        assert_eq!(settings.limits.max_chunk_bytes, 7);
    }

    /// The JWT secret is auto-generated at load time (not read from config) and
    /// must change on every call. WARNING: mutates CWD — run with
    /// --test-threads=1.
    #[test]
    fn load_generates_a_fresh_non_empty_jwt_secret_each_call() {
        let dir = tempfile::tempdir().unwrap();
        let original_cwd = std::env::current_dir().unwrap();
        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = std::env::set_current_dir(&self.0);
            }
        }
        let _guard = Restore(original_cwd);
        std::env::set_current_dir(dir.path()).unwrap();

        // A `[jwt] secret = ...` in config MUST be ignored (overwritten).
        std::fs::write(
            dir.path().join("config.toml"),
            "[jwt]\nsecret = \"operator-provided\"\naccess_ttl_seconds = 900\n",
        )
        .unwrap();

        let first = Settings::load().unwrap();
        let second = Settings::load().unwrap();

        assert!(!first.jwt.secret.is_empty(), "secret must be generated");
        assert_ne!(
            first.jwt.secret, "operator-provided",
            "a config-provided secret must be ignored"
        );
        assert_ne!(
            first.jwt.secret, second.jwt.secret,
            "secret must be regenerated on each load"
        );
    }

    /// `[security] allow_registration = false` in config.toml MUST override the
    /// open-by-default code value. WARNING: mutates CWD — run with
    /// --test-threads=1.
    #[test]
    fn load_lets_toml_close_registration() {
        let dir = tempfile::tempdir().unwrap();
        let original_cwd = std::env::current_dir().unwrap();
        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = std::env::set_current_dir(&self.0);
            }
        }
        let _guard = Restore(original_cwd);

        std::fs::write(
            dir.path().join("config.toml"),
            "[security]\nallow_registration = false\n",
        )
        .unwrap();
        std::env::set_current_dir(dir.path()).unwrap();

        let settings = Settings::load().unwrap();
        assert!(!settings.security.allow_registration);
    }
}
