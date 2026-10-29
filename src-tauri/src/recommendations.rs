//! Autoplay recommendations from the seed song's YouTube Music radio.

use crate::lyrics::matching::{clean_query_artist, clean_query_title};
use crate::models::SearchResult;
use crate::session::SessionState;
use crate::ytmusic::parse::upscale_thumbnail_url;
use crate::ytmusic::{attach_youtube_auth, web_remix_context, with_ytm_headers, HTTP_CLIENT};
use serde::Deserialize;
use tauri::State;

/// A song someone already heard, sent by the frontend so autoplay can skip other versions of it.
#[derive(Debug, Deserialize)]
pub struct ExcludedTrack {
    title: String,
    artist: String,
}

/// Identity of a song across its uploads: "Song (Official Video)" by "Artist - Topic" and
/// "Song" by "Artist feat. X" are the same song for autoplay purposes.
fn song_key(title: &str, artist: &str) -> String {
    let title = clean_query_title(title);
    // Drop any remaining bracketed suffix: (feat. …), [Remastered], (Live)…
    let title = title.split(['(', '[']).next().unwrap_or(&title);
    let (_, primary) = clean_query_artist(artist);
    let squash = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
    format!("{}|{}", squash(title), squash(&primary))
}

const RADIO_PANEL: &str = "/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs/0/tabRenderer/content/musicQueueRenderer/content/playlistPanelRenderer";

async fn post_watch_next(
    client: &reqwest::Client,
    cookies: &Option<String>,
    body: &serde_json::Value,
) -> Option<serde_json::Value> {
    let request = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/next"));
    let request = attach_youtube_auth(request, cookies);
    request.json(body).send().await.ok()?.json::<serde_json::Value>().await.ok()
}

fn parse_radio_item(item: &serde_json::Value) -> Option<SearchResult> {
    let r = item.get("playlistPanelVideoRenderer")?;
    let vid = r.get("videoId").and_then(|v| v.as_str()).filter(|v| !v.is_empty())?;
    let title = r.pointer("/title/runs/0/text").and_then(|v| v.as_str()).unwrap_or("Unknown Title");
    let artist = r
        .pointer("/longBylineText/runs")
        .or_else(|| r.pointer("/shortBylineText/runs"))
        .and_then(|v| v.as_array())
        .map(|runs| runs.iter().filter_map(|run| run.get("text").and_then(|t| t.as_str())).collect::<String>())
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| "Artist".to_string());
    let thumb = r
        .pointer("/thumbnail/thumbnails")
        .and_then(|arr| arr.as_array())
        .and_then(|arr| arr.last().or_else(|| arr.first()))
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("");
    let thumbnail_url = if thumb.is_empty() {
        format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", vid)
    } else {
        upscale_thumbnail_url(thumb)
    };
    Some(SearchResult {
        video_id: vid.to_string(),
        title: title.to_string(),
        artist,
        thumbnail_url,
        playlist_id: None,
        item_type: Some("song".to_string()),
        queue_source: None,
    })
}

/// Songs for autoplay: the seed's YouTube Music radio, minus everything the listener has
/// heard or has queued (by video ID and by song identity, so other uploads of the same song
/// don't sneak back in). Reads the whole radio panel, not just its top, and follows the
/// radio's continuation once when too few fresh songs are left.
#[tauri::command]
pub(crate) async fn get_related_recommendations(
    state: State<'_, SessionState>,
    video_id: String,
    limit: Option<usize>,
    exclude_ids: Option<Vec<String>>,
    exclude_tracks: Option<Vec<ExcludedTrack>>,
) -> Result<Vec<SearchResult>, String> {
    let clean_id = video_id.trim();
    if clean_id.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(10).clamp(1, 20);

    let mut seen_ids: std::collections::HashSet<String> =
        exclude_ids.unwrap_or_default().into_iter().collect();
    seen_ids.insert(clean_id.to_string());
    let mut seen_keys: std::collections::HashSet<String> = exclude_tracks
        .unwrap_or_default()
        .iter()
        .map(|t| song_key(&t.title, &t.artist))
        .collect();

    let client = &*HTTP_CLIENT;
    let cookies = state.cookies.lock().unwrap().clone();
    let context = web_remix_context();

    let mut picks: Vec<SearchResult> = Vec::with_capacity(limit);
    let mut take = |items: &[serde_json::Value], picks: &mut Vec<SearchResult>| {
        for track in items.iter().filter_map(parse_radio_item) {
            if picks.len() == limit {
                break;
            }
            let key = song_key(&track.title, &track.artist);
            if seen_ids.contains(&track.video_id) || seen_keys.contains(&key) {
                continue;
            }
            seen_ids.insert(track.video_id.clone());
            seen_keys.insert(key);
            picks.push(track);
        }
    };

    let body = serde_json::json!({
        "context": context,
        "videoId": clean_id,
        "playlistId": format!("RDAMVM{}", clean_id),
        "isAudioOnly": true
    });
    let Some(json) = post_watch_next(client, &cookies, &body).await else {
        return Ok(Vec::new());
    };
    let Some(panel) = json.pointer(RADIO_PANEL) else {
        return Ok(Vec::new());
    };
    if let Some(items) = panel.get("contents").and_then(|v| v.as_array()) {
        take(items, &mut picks);
    }

    // The top of a radio is mostly what was just played; go one page deeper if needed.
    const MIN_FRESH: usize = 3;
    let continuation = panel
        .pointer("/continuations/0/nextRadioContinuationData/continuation")
        .and_then(|v| v.as_str());
    if picks.len() < MIN_FRESH.min(limit) {
        if let Some(token) = continuation {
            let body = serde_json::json!({ "context": context, "continuation": token });
            if let Some(more) = post_watch_next(client, &cookies, &body).await {
                if let Some(items) = more
                    .pointer("/continuationContents/playlistPanelContinuation/contents")
                    .and_then(|v| v.as_array())
                {
                    take(items, &mut picks);
                }
            }
        }
    }

    Ok(picks)
}
