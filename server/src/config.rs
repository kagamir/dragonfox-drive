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

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: ServerSettings::default(),
            storage: StorageSettings::default(),
            database: DatabaseSettings::default(),
            jwt: JwtSettings::default(),
            limits: LimitSettings::default(),
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
            secret: "change-me-to-a-long-random-secret-in-production".into(),
            access_ttl_seconds: 900,
            refresh_ttl_seconds: 2_592_000,
        }
    }
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

        settings
            .try_deserialize::<Settings>()
            .map_err(|e| map_config_err(e))
            .context("deserializing configuration")
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
    }

    #[test]
    fn jwt_default_secret_is_the_documented_placeholder() {
        assert_eq!(
            Settings::default().jwt.secret,
            "change-me-to-a-long-random-secret-in-production",
        );
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
}
