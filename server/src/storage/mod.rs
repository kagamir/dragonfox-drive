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
