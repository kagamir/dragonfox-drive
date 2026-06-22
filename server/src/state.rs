//! Shared application state accessible to all handlers.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::config::Settings;

#[derive(Clone)]
pub struct AppState {
    pub settings: Arc<Settings>,
    pub db: SqlitePool,
}

impl AppState {
    pub fn new(settings: Arc<Settings>, db: SqlitePool) -> Self {
        Self { settings, db }
    }
}
