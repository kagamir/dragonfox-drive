//! Shared application state accessible to all handlers.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::config::Settings;

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub db: SqlitePool,
    /// Per-device `last_seen_at` write throttle: maps `device_id` → wall-clock
    /// `Instant` of the most recent `UPDATE devices SET last_seen_at` we issued.
    /// Kept in-memory (best-effort) so the hot path avoids a DB write on every
    /// request. `tokio::sync::RwLock` because we hold it across `.await`.
    pub last_seen: Arc<RwLock<HashMap<String, Instant>>>,
}

impl AppState {
    pub fn new(settings: Arc<Settings>, db: SqlitePool) -> Self {
        Self {
            settings,
            db,
            last_seen: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}
