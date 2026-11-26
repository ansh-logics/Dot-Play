//! Synced / plain lyrics lookup across several community providers, with an on-disk cache.

pub(crate) mod alternates;
pub(crate) mod matching;
mod providers;

use providers::{fetch_lyrics_candidates, fetch_lyrics_from_providers, PROVIDERS};
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

/// Resolves the provider order to query. If `pinned` names a known provider, only that
/// provider is queried. Otherwise, `provider_order` is used, falling back to the default
/// provider ranking if absent or empty. Unknown pinned names are ignored.
pub(crate) fn resolve_order(provider_order: Option<Vec<String>>, pinned: Option<String>) -> Vec<String> {
    if let Some(pin) = pinned {
        if PROVIDERS.contains(&pin.as_str()) {
            return vec![pin];
        }
    }
    match provider_order {
        Some(order) if !order.is_empty() => order,
        _ => PROVIDERS.iter().map(|&s| s.to_string()).collect(),
    }
}

/// Returns the cache file variant suffix for a given provider order. If the order matches
/// the default provider list, `None` is returned so the default cache file is used.
pub(crate) fn order_variant(order: &[String]) -> Option<String> {
    if order.len() == PROVIDERS.len() && order.iter().zip(PROVIDERS.iter()).all(|(a, b)| a == b) {
        None
    } else {
        let mut hasher = Sha1::new();
        hasher.update(order.join(",").as_bytes());
        let hex = format!("{:x}", hasher.finalize());
        Some(hex.chars().take(10).collect())
    }
}

/// Computes the cache file name for a cache key and an optional variant suffix.
pub(crate) fn cache_file_name(key: &str, variant: Option<&str>) -> String {
    match variant {
        Some(v) if !v.is_empty() => format!("{key}~{v}.json"),
        _ => format!("{key}.json"),
    }
}

fn lyrics_cache_path(
    app: &AppHandle,
    video_id: Option<&str>,
    title: &str,
    artist: &str,
    variant: Option<&str>,
) -> Option<std::path::PathBuf> {
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
    Some(dir.join(cache_file_name(&key, variant)))
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
    provider_order: Option<Vec<String>>,
    pinned: Option<String>,
) -> Result<Option<LyricsPayload>, String> {
    let order = resolve_order(provider_order, pinned);
    let variant = order_variant(&order);
    let cache_path = lyrics_cache_path(&app, video_id.as_deref(), &title, &artist, variant.as_deref());
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
    let result = fetch_lyrics_from_providers(&mut reached, video_id, title, artist, album, duration, &order).await?;

    // Only remember a miss when a provider actually answered (not when offline).
    if let Some(path) = cache_path {
        if result.is_some() || reached {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
                let entry = CachedLyrics { fetched_at: now_secs(), payload: result.clone() };
                if let Ok(data) = serde_json::to_string(&entry) {
                    if crate::fsutil::write_atomic(&path, data.as_bytes(), false).is_ok() && should_prune_now() {
                        prune_lyrics_cache(dir);
                    }
                }
            }
        }
    }
    Ok(result)
}

/// Queries all providers in the given order and collects every candidate that arrives before
/// the deadline. Does not use or touch the disk cache.
#[tauri::command]
pub(crate) async fn get_lyrics_candidates(
    video_id: Option<String>,
    title: String,
    artist: String,
    album: Option<String>,
    duration: Option<f64>,
    provider_order: Option<Vec<String>>,
) -> Result<Vec<LyricsPayload>, String> {
    let order = resolve_order(provider_order, None);
    let mut reached = false;
    fetch_lyrics_candidates(&mut reached, video_id, title, artist, album, duration, &order).await
}

/// Returns the list of supported lyrics provider identifiers in their default order.
#[tauri::command]
pub(crate) fn lyrics_providers() -> Vec<&'static str> {
    PROVIDERS.to_vec()
}

/// Prune roughly once every 50 writes rather than listing the folder each time.
fn should_prune_now() -> bool {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static WRITES: AtomicUsize = AtomicUsize::new(0);
    WRITES.fetch_add(1, Ordering::Relaxed) % 50 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_file_name_default_and_variant() {
        assert_eq!(cache_file_name("abc123_-", None), "abc123_-.json");
        assert_eq!(cache_file_name("abc123_-", Some("")), "abc123_-.json");
        assert_eq!(cache_file_name("abc123_-", Some("a1b2c3d4e5")), "abc123_-~a1b2c3d4e5.json");
    }

    #[test]
    fn order_variant_default_order_is_none() {
        let default_order: Vec<String> = PROVIDERS.iter().map(|&s| s.to_string()).collect();
        assert_eq!(order_variant(&default_order), None);
    }

    #[test]
    fn order_variant_custom_order_produces_10_hex_chars() {
        let custom = vec!["LRCLIB".to_string(), "SimpMusic".to_string()];
        let variant = order_variant(&custom).expect("custom order should have variant");
        assert_eq!(variant.len(), 10);
        assert!(variant.chars().all(|c| c.is_ascii_hexdigit()));

        // Different order produces different variant
        let custom2 = vec!["SimpMusic".to_string(), "LRCLIB".to_string()];
        let variant2 = order_variant(&custom2).expect("custom order should have variant");
        assert_ne!(variant, variant2);
    }

    #[test]
    fn resolve_order_precedence_and_fallbacks() {
        // Pin known wins over everything
        let resolved = resolve_order(
            Some(vec!["BetterLyrics".into(), "LyricsPlus".into()]),
            Some("LRCLIB".into()),
        );
        assert_eq!(resolved, vec!["LRCLIB"]);

        // Unknown pin is ignored, provider_order used
        let resolved = resolve_order(
            Some(vec!["BetterLyrics".into(), "LyricsPlus".into()]),
            Some("NonExistentProvider".into()),
        );
        assert_eq!(resolved, vec!["BetterLyrics", "LyricsPlus"]);

        // Unknown pin is ignored, None provider_order falls back to default
        let resolved = resolve_order(None, Some("NonExistentProvider".into()));
        assert_eq!(resolved.as_slice(), PROVIDERS);

        // Unknown pin is ignored, empty provider_order falls back to default
        let resolved = resolve_order(Some(vec![]), Some("NonExistentProvider".into()));
        assert_eq!(resolved.as_slice(), PROVIDERS);

        // No pin, None provider_order falls back to default
        let resolved = resolve_order(None, None);
        assert_eq!(resolved.as_slice(), PROVIDERS);

        // No pin, empty provider_order falls back to default
        let resolved = resolve_order(Some(vec![]), None);
        assert_eq!(resolved.as_slice(), PROVIDERS);

        // No pin, custom provider_order is respected
        let resolved = resolve_order(Some(vec!["Unison".into(), "SimpMusic".into()]), None);
        assert_eq!(resolved, vec!["Unison", "SimpMusic"]);
    }
}
