//! Best-available artwork lookup for tracks, with an in-memory + on-disk cache.

use crate::session::SessionState;
use crate::ytmusic::parse::{is_square_cover_url, upscale_thumbnail_url};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use tauri::{AppHandle, Manager, State};

/// Shared client for the artwork HEAD probes (3 s timeout, same options as the former
/// per-call client), so repeated lookups reuse connections to i.ytimg.com.
static PROBE_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default()
});

#[derive(Debug, Serialize, Deserialize)]
pub struct ThumbnailQuery {
    #[serde(rename = "videoId")]
    pub video_id: String,
    #[serde(rename = "currentUrl")]
    pub current_url: String,
}

#[tauri::command]
pub(crate) async fn get_highres_thumbnails(
    app: AppHandle,
    state: State<'_, SessionState>,
    tracks: Vec<ThumbnailQuery>,
) -> Result<HashMap<String, String>, String> {
    let mut results: HashMap<String, String> = HashMap::new();
    let mut to_probe: Vec<ThumbnailQuery> = Vec::new();

    // Check memory cache first
    {
        let cache = state.image_cache.lock().unwrap();
        for track in tracks {
            let key = if !track.video_id.is_empty() {
                track.video_id.clone()
            } else {
                track.current_url.clone()
            };

            // An old cached video frame doesn't override a square cover we have now.
            let stale_frame = is_square_cover_url(&track.current_url)
                && cache.get(&key).is_some_and(|u| !is_square_cover_url(u));
            if let Some(cached_url) = cache.get(&key).filter(|_| !stale_frame) {
                results.insert(key, cached_url.clone());
            } else {
                to_probe.push(track);
            }
        }
    }

    if to_probe.is_empty() {
        return Ok(results);
    }

    let mut handles = Vec::new();

    for track in to_probe {
        let client = &*PROBE_CLIENT;
        let handle = tauri::async_runtime::spawn(async move {
            let upscaled_current = upscale_thumbnail_url(&track.current_url);
            let key = if !track.video_id.is_empty() {
                track.video_id.clone()
            } else {
                track.current_url.clone()
            };

            if track.video_id.is_empty() {
                return (key, upscaled_current);
            }

            // Songs already carry their square album cover; the video-frame probes below
            // would swap it for a 16:9 frame (YouTube has one even for audio-only songs).
            if is_square_cover_url(&track.current_url) {
                return (key, upscaled_current);
            }

            // 1. Probe maxresdefault.jpg (1080p master)
            let maxres = format!("https://i.ytimg.com/vi/{}/maxresdefault.jpg", track.video_id);
            if let Ok(res) = client.head(&maxres).send().await {
                if res.status().is_success() {
                    return (key, maxres);
                }
            }

            // 2. If Google CDN upscaled is available and valid, prefer it over lower video thumbs
            if !upscaled_current.is_empty() && upscaled_current != track.current_url {
                return (key, upscaled_current);
            }

            // 3. Fallback to sddefault.jpg (640x480)
            let sddefault = format!("https://i.ytimg.com/vi/{}/sddefault.jpg", track.video_id);
            if let Ok(res) = client.head(&sddefault).send().await {
                if res.status().is_success() {
                    return (key, sddefault);
                }
            }

            // 4. Final fallback to hqdefault or upscaled current
            if !upscaled_current.is_empty() {
                (key, upscaled_current)
            } else {
                (key, format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", track.video_id))
            }
        });
        handles.push(handle);
    }

    let mut new_entries = Vec::new();
    for h in handles {
        if let Ok((id, url)) = h.await {
            if !id.is_empty() {
                results.insert(id.clone(), url.clone());
                new_entries.push((id, url));
            }
        }
    }

    // Update memory cache and save to disk
    if !new_entries.is_empty() {
        let mut cache = state.image_cache.lock().unwrap();
        for (id, url) in new_entries {
            cache.insert(id, url);
        }

        // Persist to disk
        if let Ok(app_data) = app.path().app_data_dir() {
            let cache_file = app_data.join("image_cache.json");
            let data = serde_json::to_string(&*cache).unwrap_or_default();
            let _ = std::fs::write(cache_file, data);
        }
    }

    Ok(results)
}
