//! Public, unauthenticated runtime configuration surfaced to the browser.
//!
//! Only non-secret flags belong here. It lets the frontend adapt its UI before
//! the user has logged in (e.g. hiding the registration form when the instance
//! is locked down).

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct PublicConfig {
    pub allow_registration: bool,
}

pub async fn public_config(State(state): State<AppState>) -> Json<PublicConfig> {
    Json(PublicConfig {
        allow_registration: state.settings.security.allow_registration,
    })
}
