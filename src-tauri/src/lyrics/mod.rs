//! Synced / plain lyrics lookup across several community providers, with an on-disk cache.

pub(crate) mod matching;
mod providers;

use providers::fetch_lyrics_from_providers;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LyricsPayload {
    pub source: String,
    pub isrc: Option<String>,
    pub ttml: Option<String>,
    pub synced_lyrics: Option<String>,
    pub plain_lyrics: Option<String>,
    pub rich_sync_json: Option<String>,
    pub instrumental: Option<bool>,
}

/// Lyrics found for a track are kept for good; "no lyrics" is rechecked after a while
/// in case a provider adds them.
const LYRICS_MISS_TTL_SECS: u64 = 3 * 24 * 60 * 60;
const LYRICS_CACHE_MAX_FILES: usize = 3000;

#[derive(Serialize, Deserialize)]
struct CachedLyrics {
    fetched_at: u64,
    payload: Option<LyricsPayload>,
}

fn lyrics_cache_path(app: &AppHandle, video_id: Option<&str>, title: &str, artist: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("lyrics_cache");
    let key = match video_id.map(str::trim).filter(|v| !v.is_empty()) {
        // Video IDs are [A-Za-z0-9_-], safe as file names.
        Some(vid) if vid.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') => vid.to_string(),
        _ => {
            let mut h = Sha1::new();
            h.update(format!("{}\n{}", title.trim().to_lowercase(), artist.trim().to_lowercase()));
            format!("q-{:x}", h.finalize())
        }
    };
    Some(dir.join(format!("{}.json", key)))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Keeps the cache folder bounded by dropping the least recently written files.
fn prune_lyrics_cache(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(SystemTime, std::path::PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= LYRICS_CACHE_MAX_FILES {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    let excess = files.len() - LYRICS_CACHE_MAX_FILES;
    for (_, path) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

#[tauri::command]
pub(crate) async fn get_lyrics(
    app: AppHandle,
    video_id: Option<String>,
    title: String,
    artist: String,
    album: Option<String>,
    duration: Option<f64>,
) -> Result<Option<LyricsPayload>, String> {
    let cache_path = lyrics_cache_path(&app, video_id.as_deref(), &title, &artist);
    if let Some(path) = &cache_path {
        if let Ok(contents) = std::fs::read_to_string(path) {
            if let Ok(hit) = serde_json::from_str::<CachedLyrics>(&contents) {
                if hit.payload.is_some() || now_secs().saturating_sub(hit.fetched_at) < LYRICS_MISS_TTL_SECS {
                    return Ok(hit.payload);
                }
            }
        }
    }

    let mut reached = false;
    let result = fetch_lyrics_from_providers(&mut reached, video_id, title, artist, album, duration).await?;

    // Only remember a miss when a provider actually answered (not when offline).
    if let Some(path) = cache_path {
        if result.is_some() || reached {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
                let entry = CachedLyrics { fetched_at: now_secs(), payload: result.clone() };
                if let Ok(data) = serde_json::to_string(&entry) {
                    if std::fs::write(&path, data).is_ok() && should_prune_now() {
                        prune_lyrics_cache(dir);
                    }
                }
            }
        }
    }
    Ok(result)
}

/// Prune roughly once every 50 writes rather than listing the folder each time.
fn should_prune_now() -> bool {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static WRITES: AtomicUsize = AtomicUsize::new(0);
    WRITES.fetch_add(1, Ordering::Relaxed) % 50 == 0
}
