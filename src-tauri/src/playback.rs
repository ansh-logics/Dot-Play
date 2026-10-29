//! Reports finished plays to YouTube so they show up in the listener's history.

use crate::session::SessionState;
use crate::ytmusic::{attach_youtube_auth, web_remix_context, with_ytm_headers, HTTP_CLIENT};
use sha1::{Digest, Sha1};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

fn generate_cpn() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = Sha1::new();
    hasher.update(format!("cpn_{}", timestamp).as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    hash[..16].to_string()
}

#[tauri::command]
pub(crate) async fn record_playback(
    state: State<'_, SessionState>,
    video_id: String,
    duration: f64,
    elapsed: f64,
) -> Result<bool, String> {
    let maybe_cookies = state.cookies.lock().unwrap().clone();
    if maybe_cookies.is_none() {
        println!("[DOT Music] record_playback skipped: user not logged in");
        return Ok(false);
    }

    println!(
        "[DOT Music] Recording playback to YouTube for videoId: {}, elapsed: {:.1}s / {:.1}s",
        video_id, elapsed, duration
    );

    tauri::async_runtime::spawn(async move {
        let client = &*HTTP_CLIENT;
        let player_body = serde_json::json!({
            "context": web_remix_context(),
            "videoId": video_id
        });

        let mut req = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/player"));

        req = attach_youtube_auth(req, &maybe_cookies);

        let res = match req.json(&player_body).send().await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[DOT Music] /player request failed: {}", e);
                return;
            }
        };

        let json: serde_json::Value = match res.json().await {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[DOT Music] Failed to parse /player response JSON: {}", e);
                return;
            }
        };

        let playback_url = json
            .pointer("/playbackTracking/videostatsPlaybackUrl/baseUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let watchtime_url = json
            .pointer("/playbackTracking/videostatsWatchtimeUrl/baseUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let atr_url = json
            .pointer("/playbackTracking/atrUrl/baseUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let cpn = generate_cpn();

        // 1. Initial playback ping
        if let Some(base_url) = playback_url {
            let sep = if base_url.contains('?') { '&' } else { '?' };
            let ping_url = format!("{}{}cpn={}", base_url, sep, cpn);
            let mut ping_req = with_ytm_headers(client.get(&ping_url));
            ping_req = attach_youtube_auth(ping_req, &maybe_cookies);
            if let Ok(resp) = ping_req.send().await {
                println!("[DOT Music] videostatsPlaybackUrl ping status: {}", resp.status());
            }
        }

        // 2. Watchtime ping
        if let Some(base_url) = watchtime_url {
            let sep = if base_url.contains('?') { '&' } else { '?' };
            let cmt = elapsed.max(1.0);
            let len = if duration > 0.0 { duration } else { cmt };
            let ping_url = format!(
                "{}{}cpn={}&cmt={:.1}&len={:.1}&st=0.0&et={:.1}&state=playing",
                base_url, sep, cpn, cmt, len, cmt
            );
            let mut ping_req = with_ytm_headers(client.get(&ping_url));
            ping_req = attach_youtube_auth(ping_req, &maybe_cookies);
            if let Ok(resp) = ping_req.send().await {
                println!("[DOT Music] videostatsWatchtimeUrl ping status: {}", resp.status());
            }
        }

        // 3. ATR ping
        if let Some(base_url) = atr_url {
            let sep = if base_url.contains('?') { '&' } else { '?' };
            let ping_url = format!("{}{}cpn={}", base_url, sep, cpn);
            let mut ping_req = with_ytm_headers(client.get(&ping_url));
            ping_req = attach_youtube_auth(ping_req, &maybe_cookies);
            let _ = ping_req.send().await;
        }
    });

    Ok(true)
}
