//! Playlist / album detail pages.

use crate::models::{PlaylistDetails, PlaylistPage, PlaylistTrack};
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
        .and_then(|h| {
            h.pointer("/description/runs")
                .or_else(|| h.pointer("/description/musicDescriptionShelfRenderer/description/runs"))
        })
        .and_then(|v| v.as_array())
        .map(|runs| runs.iter().filter_map(|r| r.get("text").and_then(|t| t.as_str())).collect::<String>())
        .unwrap_or_default();

    let HeaderFacts { kind, artist, year } = header_facts(header_opt);

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

    let mut shelf_opt: Option<&serde_json::Value> = None;
    if let Some(sections) = section_list_contents {
        for section in sections {
            if let Some(shelf) = section.get("musicPlaylistShelfRenderer").or_else(|| section.get("musicShelfRenderer")) {
                if shelf.get("contents").and_then(|c| c.as_array()).is_some_and(|items| !items.is_empty()) {
                    shelf_opt = Some(shelf);
                    break;
                }
            }
        }
    }

    let mut continuation = None;
    if let Some(shelf) = shelf_opt {
        let items = shelf.get("contents").and_then(|c| c.as_array()).map(Vec::as_slice).unwrap_or_default();
        tracks.extend(items.iter().filter_map(|item| parse_track(item, thumb)));
        continuation = continuation_token(items, shelf);
    }

    Ok(PlaylistDetails {
        id: clean_id.to_string(),
        title: title.to_string(),
        description,
        author,
        kind,
        artist,
        year,
        thumbnail_url: upscale_thumbnail_url(thumb),
        track_count,
        tracks,
        continuation,
    })
}

/// The next page of a playlist, from the token the previous page returned.
#[tauri::command]
pub(crate) async fn get_playlist_continuation(
    state: State<'_, SessionState>,
    continuation: String,
) -> Result<PlaylistPage, String> {
    let token = continuation.trim();
    if token.is_empty() {
        return Err("Continuation token cannot be empty".to_string());
    }
    let maybe_cookies = state.cookies.lock().unwrap().clone();
    // YouTube Music has used two continuation styles; the query parameters serve the older
    // shelf style and the body field the newer item style, so one request covers both.
    let mut url = reqwest::Url::parse("https://music.youtube.com/youtubei/v1/browse").map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("ctoken", token)
        .append_pair("continuation", token)
        .append_pair("type", "next");
    let body = serde_json::json!({ "context": web_remix_context(), "continuation": token });
    let request = attach_youtube_auth(with_ytm_headers(HTTP_CLIENT.post(url)), &maybe_cookies);
    let json: serde_json::Value = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch more songs: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse more songs: {}", e))?;
    Ok(parse_continuation_page(&json))
}

fn parse_continuation_page(json: &serde_json::Value) -> PlaylistPage {
    if let Some(shelf) = json
        .pointer("/continuationContents/musicPlaylistShelfContinuation")
        .or_else(|| json.pointer("/continuationContents/musicShelfContinuation"))
    {
        let items = shelf.get("contents").and_then(|c| c.as_array()).map(Vec::as_slice).unwrap_or_default();
        return PlaylistPage {
            tracks: items.iter().filter_map(|item| parse_track(item, "")).collect(),
            continuation: continuation_token(items, shelf),
        };
    }
    let items = json
        .pointer("/onResponseReceivedActions/0/appendContinuationItemsAction/continuationItems")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    PlaylistPage {
        tracks: items.iter().filter_map(|item| parse_track(item, "")).collect(),
        continuation: continuation_token(items, &serde_json::Value::Null),
    }
}

/// The token for the next page: a trailing `continuationItemRenderer` (newer responses) or
/// the shelf's `nextContinuationData` (older ones).
fn continuation_token(items: &[serde_json::Value], shelf: &serde_json::Value) -> Option<String> {
    items
        .last()
        .and_then(|item| item.pointer("/continuationItemRenderer/continuationEndpoint/continuationCommand/token"))
        .or_else(|| shelf.pointer("/continuations/0/nextContinuationData/continuation"))
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

fn parse_track(item: &serde_json::Value, fallback_thumb: &str) -> Option<PlaylistTrack> {
    let r = item.get("musicResponsiveListItemRenderer")?;
    let video_id = r
        .pointer("/playlistItemData/videoId")
        .or_else(|| r.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId"))
        .or_else(|| r.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint/videoId"))
        .and_then(|v| v.as_str())?;
    let track_title = r
        .pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/text")
        .and_then(|v| v.as_str())?;
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
        .unwrap_or(fallback_thumb);
    let (title, artist) = clean_ytmusic_title_and_artist(track_title, &raw_artist);
    Some(PlaylistTrack {
        video_id: video_id.to_string(),
        title,
        artist,
        duration: duration.to_string(),
        thumbnail_url: upscale_thumbnail_url(track_thumb),
    })
}

/// The header's subtitle split into its parts. YouTube Music sends one line such as
/// "Album • Artist • 2023" (older header) or "Album • 2023" plus the artist on its own
/// strapline (newer header).
struct HeaderFacts {
    /// "Album", "Single", "EP", "Playlist"…
    kind: Option<String>,
    artist: Option<String>,
    year: Option<String>,
}

const HEADER_KINDS: &[&str] = &["Album", "Single", "EP", "Playlist", "Podcast", "Audiobook"];

fn runs_text(runs: Option<&serde_json::Value>) -> Option<String> {
    let text: String = runs?
        .as_array()?
        .iter()
        .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
        .collect();
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn header_facts(header: Option<&serde_json::Value>) -> HeaderFacts {
    let Some(header) = header else {
        return HeaderFacts { kind: None, artist: None, year: None };
    };
    let subtitle = runs_text(header.pointer("/subtitle/runs")).unwrap_or_default();
    let mut kind = None;
    let mut year = None;
    let mut rest = Vec::new();
    for part in subtitle.split('•').map(str::trim).filter(|p| !p.is_empty()) {
        if kind.is_none() && HEADER_KINDS.contains(&part) {
            kind = Some(part.to_string());
        } else if year.is_none() && part.len() == 4 && part.chars().all(|c| c.is_ascii_digit()) {
            year = Some(part.to_string());
        } else {
            rest.push(part);
        }
    }
    let artist = runs_text(header.pointer("/straplineTextOne/runs"))
        .or_else(|| (!rest.is_empty()).then(|| rest.join(" • ")));
    HeaderFacts { kind, artist, year }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str) -> serde_json::Value {
        json!({ "musicResponsiveListItemRenderer": {
            "playlistItemData": { "videoId": id },
            "flexColumns": [
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": format!("Song {id}") }] } } },
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": "Artist" }] } } }
            ]
        }})
    }

    #[test]
    fn newer_continuations_are_followed() {
        let page = json!({ "onResponseReceivedActions": [{ "appendContinuationItemsAction": { "continuationItems": [
            row("a"), row("b"),
            { "continuationItemRenderer": { "continuationEndpoint": { "continuationCommand": { "token": "NEXT" } } } }
        ] } }] });
        let parsed = parse_continuation_page(&page);
        assert_eq!(parsed.tracks.len(), 2);
        assert_eq!(parsed.continuation.as_deref(), Some("NEXT"));
    }

    #[test]
    fn older_continuations_are_followed_and_the_last_page_ends() {
        let page = json!({ "continuationContents": { "musicPlaylistShelfContinuation": {
            "contents": [row("c")],
            "continuations": [{ "nextContinuationData": { "continuation": "OLD" } }]
        } } });
        let parsed = parse_continuation_page(&page);
        assert_eq!(parsed.tracks[0].video_id, "c");
        assert_eq!(parsed.continuation.as_deref(), Some("OLD"));

        let last = json!({ "continuationContents": { "musicPlaylistShelfContinuation": { "contents": [row("d")] } } });
        assert_eq!(parse_continuation_page(&last).continuation, None);
    }
}
