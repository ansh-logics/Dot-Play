//! Playlist / album detail pages.

use crate::models::{PlaylistDetails, PlaylistTrack};
use crate::session::SessionState;
use crate::ytmusic::parse::{clean_ytmusic_title_and_artist, parse_ytmusic_artist_from_runs, upscale_thumbnail_url};
use crate::ytmusic::{attach_youtube_auth, web_remix_context, with_ytm_headers, HTTP_CLIENT};
use tauri::State;

#[tauri::command]
pub(crate) async fn get_playlist_details(
    state: State<'_, SessionState>,
    playlist_id: String,
) -> Result<PlaylistDetails, String> {
    let clean_id = playlist_id.trim();
    if clean_id.is_empty() {
        return Err("Playlist ID cannot be empty".to_string());
    }

    let client = &*HTTP_CLIENT;
    let maybe_cookies = state.cookies.lock().unwrap().clone();

    let browse_id = if clean_id.starts_with("VL") || clean_id.starts_with("MPRE") {
        clean_id.to_string()
    } else {
        format!("VL{}", clean_id)
    };

    let body = serde_json::json!({
        "context": web_remix_context(),
        "browseId": browse_id
    });

    let mut request = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/browse"));

    request = attach_youtube_auth(request, &maybe_cookies);

    let res = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch playlist details: {}", e))?;

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse playlist JSON: {}", e))?;

    // 1. Extract Header Metadata
    let header_opt = json.pointer("/header/musicDetailHeaderRenderer")
        .or_else(|| json.pointer("/header/musicResponsiveHeaderRenderer"))
        .or_else(|| json.pointer("/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicResponsiveHeaderRenderer"));

    let title = header_opt
        .and_then(|h| h.pointer("/title/runs/0/text"))
        .and_then(|v| v.as_str())
        .unwrap_or("Playlist");

    let mut author_parts = Vec::new();
    if let Some(runs) = header_opt.and_then(|h| h.pointer("/subtitle/runs")).and_then(|v| v.as_array()) {
        for run in runs {
            if let Some(txt) = run.get("text").and_then(|v| v.as_str()) {
                author_parts.push(txt);
            }
        }
    }
    let author = if !author_parts.is_empty() {
        author_parts.join("")
    } else {
        "YouTube Music".to_string()
    };

    let mut track_count_parts = Vec::new();
    if let Some(runs) = header_opt.and_then(|h| h.pointer("/secondSubtitle/runs")).and_then(|v| v.as_array()) {
        for run in runs {
            if let Some(txt) = run.get("text").and_then(|v| v.as_str()) {
                track_count_parts.push(txt);
            }
        }
    }
    let track_count = if !track_count_parts.is_empty() {
        track_count_parts.join("")
    } else {
        "".to_string()
    };

    let description = header_opt
        .and_then(|h| h.pointer("/description/runs/0/text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let thumb = header_opt
        .and_then(|h| {
            h.pointer("/thumbnail/croppedSquareThumbnailRenderer/thumbnail/thumbnails")
                .or_else(|| h.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails"))
        })
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.last().or_else(|| arr.first()))
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("");

    // 2. Extract Tracks
    let mut tracks = Vec::new();

    let section_list_contents = json.pointer("/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer/contents")
        .or_else(|| json.pointer("/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents"))
        .or_else(|| json.pointer("/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents"))
        .and_then(|v| v.as_array());

    let mut items_opt: Option<&Vec<serde_json::Value>> = None;
    if let Some(sections) = section_list_contents {
        for section in sections {
            if let Some(shelf) = section.get("musicPlaylistShelfRenderer").or_else(|| section.get("musicShelfRenderer")) {
                if let Some(items) = shelf.get("contents").and_then(|c| c.as_array()) {
                    if !items.is_empty() {
                        items_opt = Some(items);
                        break;
                    }
                }
            }
        }
    }

    if let Some(items) = items_opt {
        for item in items {
            if let Some(r) = item.get("musicResponsiveListItemRenderer") {
                let video_id = r
                    .pointer("/playlistItemData/videoId")
                    .or_else(|| r.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId"))
                    .or_else(|| r.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint/videoId"))
                    .and_then(|v| v.as_str());

                let track_title = r
                    .pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/text")
                    .and_then(|v| v.as_str());

                let raw_artist = r
                    .pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs")
                    .and_then(|v| v.as_array())
                    .map(|runs| parse_ytmusic_artist_from_runs(runs))
                    .unwrap_or_else(|| "Artist".to_string());

                let duration = r
                    .pointer("/fixedColumns/0/musicResponsiveListItemFixedColumnRenderer/text/runs/0/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let track_thumb = r
                    .pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.last().or_else(|| arr.first()))
                    .and_then(|t| t.get("url"))
                    .and_then(|u| u.as_str())
                    .unwrap_or(thumb);
                let final_track_thumb = upscale_thumbnail_url(track_thumb);

                if let (Some(id), Some(t)) = (video_id, track_title) {
                    let (clean_t, clean_a) = clean_ytmusic_title_and_artist(t, &raw_artist);
                    tracks.push(PlaylistTrack {
                        video_id: id.to_string(),
                        title: clean_t,
                        artist: clean_a,
                        duration: duration.to_string(),
                        thumbnail_url: final_track_thumb,
                    });
                }
            }
        }
    }

    Ok(PlaylistDetails {
        id: clean_id.to_string(),
        title: title.to_string(),
        description,
        author,
        thumbnail_url: upscale_thumbnail_url(thumb),
        track_count,
        tracks,
    })
}
