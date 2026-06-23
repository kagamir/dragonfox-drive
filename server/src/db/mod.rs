//! Database connection & migrations.

use anyhow::Result;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use std::{str::FromStr, time::Duration};

pub async fn connect(url: &str) -> Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str(url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;

    Ok(pool)
}

pub async fn migrate(pool: &SqlitePool) -> Result<()> {
    // PRAGMA foreign_keys is per-connection in SQLite.
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await?;

    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_opens_a_working_pool() {
        let pool = connect("sqlite::memory:").await.unwrap();
        let row: (i64,) = sqlx::query_as("SELECT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, 1);
    }

    #[tokio::test]
    async fn migrate_creates_all_expected_tables() {
        // sqlite::memory: is per-connection in sqlx, so use a tempfile-backed
        // file DB to share the schema across the pool's connections.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir
            .path()
            .join("test.db")
            .to_string_lossy()
            .replace('\\', "/");
        let url = format!("sqlite://{}?mode=rwc", db_path);

        let pool = connect(&url).await.unwrap();
        migrate(&pool).await.unwrap();

        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();
        let names: Vec<String> = rows.into_iter().map(|r| r.0).collect();

        for expected in [
            "devices",
            "file_chunks",
            "files",
            "refresh_tokens",
            "shares",
            "users",
        ] {
            assert!(
                names.contains(&expected.to_string()),
                "missing table {expected}; got {names:?}"
            );
        }

        // P1: the email column was renamed to username.
        let col_names: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM pragma_table_info('users') ORDER BY cid",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let names: Vec<String> = col_names.into_iter().map(|r| r.0).collect();
        assert!(
            names.contains(&"username".to_string()),
            "users must have a `username` column; got {names:?}"
        );
        assert!(
            !names.contains(&"email".to_string()),
            "users must NOT have an `email` column; got {names:?}"
        );
    }
}
