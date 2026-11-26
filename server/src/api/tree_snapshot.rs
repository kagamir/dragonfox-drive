//! The revision and the encrypted rows it describes must be read in the same transaction.
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::error::{ApiError, ApiResult};

#[derive(Clone, Copy)]
pub(super) enum Listing { Folders, Files }

impl Listing {
    pub(super) async fn token(self, db: &mut SqliteConnection, owner: &str) -> ApiResult<String> {
        let query = match self {
            Self::Folders => "SELECT folder_revision FROM users WHERE id = ?",
            Self::Files => "SELECT file_revision FROM users WHERE id = ?",
        };
        let version: i64 = sqlx::query_scalar(query).bind(owner).fetch_one(db).await?;
        Ok(version.to_string())
    }

    pub(super) async fn verify(self, db: &mut SqliteConnection, owner: &str, expected: Option<&str>) -> ApiResult<()> {
        if let Some(expected) = expected {
            if expected != self.token(db, owner).await? {
                return Err(ApiError::Conflict("Folder contents have changed. Refresh and try again.".into()));
            }
        }
        Ok(())
    }
}

pub(super) async fn check(db: &mut SqliteConnection, owner: &str, body: &Value) -> ApiResult<()> {
    for (field, listing) in [("expected_folder_snapshot", Listing::Folders), ("expected_file_snapshot", Listing::Files)] {
        if let Some(value) = body.get(field) {
            let expected = value.as_str().ok_or_else(|| ApiError::BadRequest(format!("{field} must be a string")))?;
            listing.verify(db, owner, Some(expected)).await?;
        }
    }
    Ok(())
}
