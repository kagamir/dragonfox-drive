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
    pub max_upload_bytes: u64,
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
            max_upload_bytes: 0,
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
