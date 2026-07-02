//! On-disk storage of encrypted file chunks.
//!
//! Layout: `<data_dir>/blobs/<shard_2>/<next_2>/<file_id>/chunk_<NNN>`.
//! Files are sharded across directories to avoid huge directories.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;

use crate::state::AppState;

pub fn chunk_path(data_dir: &Path, file_id: &str, chunk_index: u32) -> PathBuf {
    let shard1 = &file_id[..2.min(file_id.len())];
    let shard2 = if file_id.len() >= 4 {
        &file_id[2..4]
    } else {
        "00"
    };

    data_dir
        .join("blobs")
        .join(shard1)
        .join(shard2)
        .join(file_id)
        .join(format!("chunk_{}", chunk_index))
}

pub async fn write_chunk(
    state: &AppState,
    file_id: &str,
    chunk_index: u32,
    bytes: &[u8],
) -> Result<()> {
    let path = chunk_path(&state.settings.storage.data_dir, file_id, chunk_index);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating chunk directory {}", parent.display()))?;
    }

    // Write atomically via temp file then rename.
    let tmp = path.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("creating temp file {}", tmp.display()))?;
    file.write_all(bytes)
        .await
        .with_context(|| format!("writing chunk {}", chunk_index))?;
    file.sync_all().await?;
    drop(file);

    tokio::fs::rename(&tmp, &path)
        .await
        .with_context(|| format!("renaming temp chunk file"))?;

    Ok(())
}

pub async fn read_chunk(
    state: &AppState,
    file_id: &str,
    chunk_index: u32,
) -> Result<Option<Vec<u8>>> {
    let path = chunk_path(&state.settings.storage.data_dir, file_id, chunk_index);
    match tokio::fs::read(&path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::anyhow!(e)),
    }
}

pub async fn delete_file_chunks(state: &AppState, file_id: &str) -> Result<()> {
    let shard1 = &file_id[..2.min(file_id.len())];
    let shard2 = if file_id.len() >= 4 {
        &file_id[2..4]
    } else {
        "00"
    };
    let dir: PathBuf = state
        .settings
        .storage
        .data_dir
        .join("blobs")
        .join(shard1)
        .join(shard2)
        .join(file_id);

    match tokio::fs::remove_dir_all(&dir).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow::anyhow!(e)),
    }
}

/// Stage a replacement for chunk `chunk_index`: write the bytes to a
/// sibling `.staged-<uuid>` file (fsync'd) WITHOUT touching the live chunk.
/// The uuid suffix is load-bearing: two concurrent replaces for the same
/// chunk must not share a staging file, or whichever commits/promotes last
/// silently clobbers the other's already-promoted content with stale or
/// undecryptable bytes. The caller promotes the returned path with
/// `promote_staged_chunk` after its DB transaction commits, so a failure at
/// any earlier point leaves the old content intact.
pub async fn stage_chunk(
    state: &AppState,
    file_id: &str,
    chunk_index: u32,
    bytes: &[u8],
) -> Result<PathBuf> {
    let path = chunk_path(&state.settings.storage.data_dir, file_id, chunk_index);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating chunk directory {}", parent.display()))?;
    }
    let staged = path.with_extension(format!("staged-{}", uuid::Uuid::new_v4()));
    let mut file = tokio::fs::File::create(&staged)
        .await
        .with_context(|| format!("creating staged file {}", staged.display()))?;
    file.write_all(bytes)
        .await
        .with_context(|| format!("writing staged chunk {}", chunk_index))?;
    file.sync_all().await?;
    Ok(staged)
}

/// Atomically promote a previously staged chunk (returned by `stage_chunk`)
/// over the live one.
pub async fn promote_staged_chunk(
    state: &AppState,
    file_id: &str,
    chunk_index: u32,
    staged: &Path,
) -> Result<()> {
    let path = chunk_path(&state.settings.storage.data_dir, file_id, chunk_index);
    tokio::fs::rename(staged, &path)
        .await
        .with_context(|| format!("promoting staged chunk {}", staged.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;
    use crate::db;
    use crate::state::AppState;
    use proptest::prelude::*;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    async fn test_state(dir: &Path) -> AppState {
        let mut settings = Settings::default();
        settings.storage.data_dir = dir.to_path_buf();
        let pool = db::connect("sqlite::memory:").await.unwrap();
        AppState::new(Arc::new(settings), pool)
    }

    fn expected_chunk_path(
        root: &str,
        id: &str,
        shard1: &str,
        shard2: &str,
        idx: u32,
    ) -> PathBuf {
        PathBuf::from(root)
            .join("blobs")
            .join(shard1)
            .join(shard2)
            .join(id)
            .join(format!("chunk_{}", idx))
    }

    #[test]
    fn chunk_path_shards_long_id() {
        let p = chunk_path(Path::new("/data"), "abcdef-1234", 3);
        assert_eq!(
            p,
            expected_chunk_path("/data", "abcdef-1234", "ab", "cd", 3)
        );
    }

    #[test]
    fn chunk_path_uses_short_id_fallbacks() {
        // one-char id: shard1 = "x", shard2 = "00" (len < 4)
        assert_eq!(
            chunk_path(Path::new("/d"), "x", 0),
            expected_chunk_path("/d", "x", "x", "00", 0)
        );
        // three-char id: shard1 = "ab", shard2 = "00" (len < 4)
        assert_eq!(
            chunk_path(Path::new("/d"), "abc", 1),
            expected_chunk_path("/d", "abc", "ab", "00", 1)
        );
    }

    #[tokio::test]
    async fn write_and_read_chunk_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        let payload = b"hello chunks";
        write_chunk(&state, "file-1", 0, payload).await.unwrap();
        assert_eq!(
            read_chunk(&state, "file-1", 0).await.unwrap(),
            Some(payload.to_vec())
        );
    }

    #[tokio::test]
    async fn write_chunk_leaves_no_tmp_file() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"data").await.unwrap();
        let chunk = chunk_path(&state.settings.storage.data_dir, "file-1", 0);
        let tmp = chunk.with_extension("tmp");
        assert!(!tmp.exists(), "temp file should have been renamed away");
        assert!(chunk.exists());
    }

    #[tokio::test]
    async fn read_chunk_returns_none_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        assert_eq!(read_chunk(&state, "nope", 0).await.unwrap(), None);
    }

    #[tokio::test]
    async fn delete_file_chunks_is_idempotent_and_removes_directory() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"a").await.unwrap();
        write_chunk(&state, "file-1", 1, b"b").await.unwrap();
        delete_file_chunks(&state, "file-1").await.unwrap();
        delete_file_chunks(&state, "file-1").await.unwrap();
        assert!(read_chunk(&state, "file-1", 0).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_file_chunks_leaves_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"a").await.unwrap();
        write_chunk(&state, "file-2", 0, b"b").await.unwrap();
        delete_file_chunks(&state, "file-1").await.unwrap();
        assert!(read_chunk(&state, "file-2", 0).await.unwrap().is_some());
    }

    proptest! {
        /// chunk_path is exercised over ASCII ids only — matches the real
        /// contract (callers use UUIDs). Multi-byte ids would panic on the
        /// byte-slice `&file_id[..2]`; that is a documented constraint, not a
        /// bug to fix here.
        #[test]
        fn chunk_path_structure_for_ascii_ids(
            id in "[a-zA-Z0-9]{4,64}",
            idx in 0u32..100_000,
        ) {
            let p = chunk_path(Path::new("/data"), &id, idx);
            let s = p.to_string_lossy().into_owned();
            let chunk_name = format!("chunk_{}", idx);
            // Hoisted into a var so the `prop_assert!` expression stringifies
            // without a `{}` that would break the macro's failure-message fmt.
            prop_assert!(s.contains("blobs"));
            prop_assert!(s.contains(&chunk_name));
            prop_assert!(s.contains(&id));
        }
    }

    #[tokio::test]
    async fn stage_chunk_leaves_live_chunk_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"old").await.unwrap();
        let staged = stage_chunk(&state, "file-1", 0, b"new").await.unwrap();
        assert_eq!(
            read_chunk(&state, "file-1", 0).await.unwrap(),
            Some(b"old".to_vec()),
            "staging must not overwrite the live chunk"
        );
        assert!(staged.exists());
    }

    #[tokio::test]
    async fn promote_staged_chunk_replaces_live_content() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"old").await.unwrap();
        let staged = stage_chunk(&state, "file-1", 0, b"new").await.unwrap();
        promote_staged_chunk(&state, "file-1", 0, &staged).await.unwrap();
        assert_eq!(
            read_chunk(&state, "file-1", 0).await.unwrap(),
            Some(b"new".to_vec())
        );
        assert!(!staged.exists(), "staged file must be renamed away");
    }

    #[tokio::test]
    async fn stage_chunk_works_without_existing_directory() {
        // A replace can race a fresh state where the blob dir was never
        // created; stage_chunk must create parents like write_chunk does.
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        let staged = stage_chunk(&state, "file-9", 0, b"x").await.unwrap();
        promote_staged_chunk(&state, "file-9", 0, &staged).await.unwrap();
        assert_eq!(read_chunk(&state, "file-9", 0).await.unwrap(), Some(b"x".to_vec()));
    }

    #[tokio::test]
    async fn concurrent_stagers_get_distinct_files_and_first_promote_wins() {
        // Reproduces the scenario Fix 2 closes: two concurrent replace_content
        // calls for the same chunk must not share one staging file. With a
        // shared fixed name, A stages → A commits+promotes → B stages
        // (overwriting A's staged file) → A's already-committed DB row would
        // point at bytes that no longer match what's on disk. With per-call
        // uuid-suffixed names, both stagings coexist independently.
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"old").await.unwrap();
        let staged_a = stage_chunk(&state, "file-1", 0, b"from-a").await.unwrap();
        let staged_b = stage_chunk(&state, "file-1", 0, b"from-b").await.unwrap();
        assert_ne!(staged_a, staged_b, "concurrent stagers must not share a file name");

        // A commits and promotes first.
        promote_staged_chunk(&state, "file-1", 0, &staged_a).await.unwrap();
        assert_eq!(
            read_chunk(&state, "file-1", 0).await.unwrap(),
            Some(b"from-a".to_vec()),
            "A's promote must install A's bytes"
        );
        // B's staged file must still exist, untouched by A's promote.
        assert_eq!(tokio::fs::read(&staged_b).await.unwrap(), b"from-b");
        tokio::fs::remove_file(&staged_b).await.unwrap();
    }

    #[tokio::test]
    async fn staged_file_cleanup_removes_it_without_touching_the_live_chunk() {
        // We can't deterministically force replace_content's in-tx 409 race
        // (rows_affected == 0) from outside without injection hooks — it
        // requires another writer to land between the handler's initial
        // SELECT and its transactional UPDATE, and the handler re-SELECTs
        // internally so there's no seam to interleave through in a plain
        // unit test. Instead this exercises the cleanup primitive the
        // handler relies on directly: a staged file removed via best-effort
        // `remove_file` (as replace_content does on every post-staging error
        // path) leaves no trace and the live chunk is untouched.
        let dir = tempfile::tempdir().unwrap();
        let state = test_state(dir.path()).await;
        write_chunk(&state, "file-1", 0, b"old").await.unwrap();
        let staged = stage_chunk(&state, "file-1", 0, b"new").await.unwrap();
        assert!(staged.exists());
        tokio::fs::remove_file(&staged).await.unwrap();
        assert!(!staged.exists());
        assert_eq!(read_chunk(&state, "file-1", 0).await.unwrap(), Some(b"old".to_vec()));
    }
}
