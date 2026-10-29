//! Song search.

use crate::models::SearchResult;
use crate::ytmusic::parse::{clean_ytmusic_title_and_artist, parse_ytmusic_artist_from_runs, upscale_thumbnail_url};
use crate::ytmusic::{web_remix_context, with_ytm_headers, HTTP_CLIENT};

#[tauri::command]
pub(crate) async fn search_tracks(query: String) -> Result<Vec<SearchResult>, String> {
    let clean_query = query.trim();
    if clean_query.is_empty() {
        return Ok(Vec::new());
    }

    let client = &*HTTP_CLIENT;
    let body = serde_json::json!({
        "context": web_remix_context(),
        "query": clean_query
    });

    let res = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/search"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let mut results = Vec::new();

    // 1. Check top hit (musicCardShelfRenderer)
    if let Some(card) = json.pointer(
        "/contents/tabbedSearchResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicCardShelfRenderer",
    ) {
        let video_id = card
            .pointer("/title/runs/0/navigationEndpoint/watchEndpoint/videoId")
            .and_then(|v| v.as_str());
        let title = card.pointer("/title/runs/0/text").and_then(|v| v.as_str());
        let raw_thumb = card
            .pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails")
            .or_else(|| card.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails"))
            .or_else(|| card.pointer("/thumbnail/thumbnails"))
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.last().or_else(|| arr.first()))
            .and_then(|t| t.get("url"))
            .and_then(|u| u.as_str())
            .unwrap_or("");
        let thumb = upscale_thumbnail_url(raw_thumb);

        let subtitle_runs = card.pointer("/subtitle/runs").and_then(|v| v.as_array());
        let raw_artist = subtitle_runs
            .map(|runs| parse_ytmusic_artist_from_runs(runs))
            .unwrap_or_else(|| "YouTube Music".to_string());

        if let (Some(id), Some(t)) = (video_id, title) {
            let (clean_t, clean_a) = clean_ytmusic_title_and_artist(t, &raw_artist);
            results.push(SearchResult {
                video_id: id.to_string(),
                title: clean_t,
                artist: clean_a,
                thumbnail_url: thumb.to_string(),
                playlist_id: None,
                item_type: Some("song".to_string()),
                queue_source: None,
            });
        }
    }

    // 2. Check song list items (musicResponsiveListItemRenderer)
    if let Some(sections) = json.pointer(
        "/contents/tabbedSearchResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents",
    ).and_then(|v| v.as_array()) {
        for section in sections {
            let items_opt = section
                .pointer("/itemSectionRenderer/contents")
                .or_else(|| section.pointer("/musicShelfRenderer/contents"))
                .and_then(|v| v.as_array());

            if let Some(items) = items_opt {
                for item in items {
                    if let Some(item_renderer) = item.get("musicResponsiveListItemRenderer") {
                        let video_id = item_renderer
                            .pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId")
                            .or_else(|| item_renderer.pointer("/playlistItemData/videoId"))
                            .or_else(|| item_renderer.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint/videoId"))
                            .and_then(|v| v.as_str());

                        let title = item_renderer
                            .pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/text")
                            .and_then(|v| v.as_str());

                        let subtitle_runs = item_renderer
                            .pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs")
                            .and_then(|v| v.as_array());
                        let raw_artist = subtitle_runs
                            .map(|runs| parse_ytmusic_artist_from_runs(runs))
                            .unwrap_or_else(|| "Unknown Artist".to_string());

                        let raw_thumb = item_renderer
                            .pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails")
                            .or_else(|| item_renderer.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails"))
                            .or_else(|| item_renderer.pointer("/thumbnail/thumbnails"))
                            .and_then(|v| v.as_array())
                            .and_then(|arr| arr.last().or_else(|| arr.first()))
                            .and_then(|t| t.get("url"))
                            .and_then(|u| u.as_str())
                            .unwrap_or("");
                        let thumb = upscale_thumbnail_url(raw_thumb);

                        if let (Some(id), Some(t)) = (video_id, title) {
                            let (clean_t, clean_a) = clean_ytmusic_title_and_artist(t, &raw_artist);
                            if !results.iter().any(|r| r.video_id == id) {
                                results.push(SearchResult {
                                    video_id: id.to_string(),
                                    title: clean_t,
                                    artist: clean_a,
                                    thumbnail_url: thumb.to_string(),
                                    playlist_id: None,
                                    item_type: Some("song".to_string()),
                                    queue_source: None,
                                });
                            }
                        }

                        if results.len() >= 10 {
                            break;
                        }
                    }
                }
            }
            if results.len() >= 10 {
                break;
            }
        }
    }

    Ok(results)
}
