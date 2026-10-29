//! Home feed, its continuation pages, listening history and library playlists.

use crate::models::{HomeFeedResponse, HomeSection};
use crate::search::search_tracks;
use crate::session::SessionState;
use crate::ytmusic::parse::{extract_continuation_token, parse_feed_item, parse_shelves};
use crate::ytmusic::{attach_youtube_auth, web_remix_context, with_ytm_headers, HTTP_CLIENT};
use tauri::State;

#[tauri::command]
pub(crate) async fn get_home_feed(state: State<'_, SessionState>) -> Result<HomeFeedResponse, String> {
    let client = &*HTTP_CLIENT;
    let maybe_cookies = state.cookies.lock().unwrap().clone();

    let body = serde_json::json!({
        "context": web_remix_context(),
        "browseId": "FEmusic_home"
    });

    let mut request = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/browse"));

    request = attach_youtube_auth(request, &maybe_cookies);

    if let Ok(res) = request.json(&body).send().await {
        if let Ok(json) = res.json::<serde_json::Value>().await {
            let mut sections = Vec::new();
            let mut continuation_token = None;

            if let Some(shelves) = json.pointer(
                "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents",
            ).and_then(|v| v.as_array()) {
                sections = parse_shelves(shelves);
            }

            if let Some(section_list) = json.pointer(
                "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer"
            ) {
                continuation_token = extract_continuation_token(section_list);
            }

            if !sections.is_empty() {
                return Ok(HomeFeedResponse {
                    sections,
                    continuation_token,
                });
            }
        }
    }

    // Fallback: If network or browse failed, populate trending shelves
    let (trending, chill) = tokio::join!(
        search_tracks("trending music 2026".to_string()),
        search_tracks("lofi chill beats".to_string()),
    );
    let (trending, chill) = (trending.unwrap_or_default(), chill.unwrap_or_default());

    let mut fallback_sections = Vec::new();
    if !trending.is_empty() {
        fallback_sections.push(HomeSection {
            title: "Trending on YouTube Music".to_string(),
            items: trending,
        });
    }
    if !chill.is_empty() {
        fallback_sections.push(HomeSection {
            title: "Chill & Relax".to_string(),
            items: chill,
        });
    }

    Ok(HomeFeedResponse {
        sections: fallback_sections,
        continuation_token: None,
    })
}

#[tauri::command]
pub(crate) async fn get_home_feed_continuation(
    state: State<'_, SessionState>,
    continuation: String,
) -> Result<HomeFeedResponse, String> {
    let clean_continuation = continuation.trim();
    if clean_continuation.is_empty() {
        return Ok(HomeFeedResponse {
            sections: Vec::new(),
            continuation_token: None,
        });
    }

    let client = &*HTTP_CLIENT;
    let maybe_cookies = state.cookies.lock().unwrap().clone();

    let body = serde_json::json!({
        "context": web_remix_context(),
        "continuation": clean_continuation
    });

    // The token can contain '%', '=' and '+', so it goes through the query encoder.
    let mut request = with_ytm_headers(
        client
            .post("https://music.youtube.com/youtubei/v1/browse")
            .query(&[("continuation", clean_continuation), ("ctoken", clean_continuation)]),
    );

    request = attach_youtube_auth(request, &maybe_cookies);

    let res = request
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Continuation network error: {}", e))?;

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse continuation response: {}", e))?;

    let mut sections = Vec::new();
    let mut next_token = None;

    if let Some(shelves) = json.pointer("/continuationContents/sectionListContinuation/contents")
        .and_then(|v| v.as_array()) {
        sections = parse_shelves(shelves);
    }

    if let Some(section_list) = json.pointer("/continuationContents/sectionListContinuation") {
        next_token = extract_continuation_token(section_list);
    }

    Ok(HomeFeedResponse {
        sections,
        continuation_token: next_token,
    })
}

#[tauri::command]
pub(crate) async fn get_history(state: State<'_, SessionState>) -> Result<HomeFeedResponse, String> {
    let maybe_cookies = state.cookies.lock().unwrap().clone();
    if maybe_cookies.is_none() {
        return Ok(HomeFeedResponse {
            sections: Vec::new(),
            continuation_token: None,
        });
    }

    let client = &*HTTP_CLIENT;
    let body = serde_json::json!({
        "context": web_remix_context(),
        "browseId": "FEmusic_history"
    });

    let mut request = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/browse"));

    request = attach_youtube_auth(request, &maybe_cookies);

    // Failures are errors, not an empty list: the app keeps its saved copy of the
    // history and would otherwise replace it with nothing.
    let res = request
        .json(&body)
        .send()
        .await
        .and_then(|res| res.error_for_status())
        .map_err(|e| format!("History request failed: {e}"))?;
    let json = res
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("History response could not be read: {e}"))?;

    let section_list = json.pointer(
        "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer",
    );
    let sections = section_list
        .and_then(|list| list.pointer("/contents"))
        .and_then(|v| v.as_array())
        .map(|shelves| parse_shelves(shelves))
        .unwrap_or_default();
    let continuation_token = section_list.and_then(extract_continuation_token);

    Ok(HomeFeedResponse {
        sections,
        continuation_token,
    })
}

#[tauri::command]
pub(crate) async fn get_library_playlists(state: State<'_, SessionState>) -> Result<HomeFeedResponse, String> {
    let maybe_cookies = state.cookies.lock().unwrap().clone();
    if maybe_cookies.is_none() {
        return Ok(HomeFeedResponse {
            sections: Vec::new(),
            continuation_token: None,
        });
    }

    let client = &*HTTP_CLIENT;
    let browse_ids = ["FEmusic_liked_playlists", "FEmusic_library_landing"];
    // Empty only when YouTube answered with nothing; unreachable is an error, so the app
    // keeps the playlists it already shows instead of clearing them.
    let mut answered = false;

    for browse_id in browse_ids {
        let body = serde_json::json!({
            "context": web_remix_context(),
            "browseId": browse_id
        });

        let mut request = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/browse"));

        request = attach_youtube_auth(request, &maybe_cookies);

        let response = request
            .json(&body)
            .send()
            .await
            .and_then(|res| res.error_for_status());
        if let Ok(res) = response {
            if let Ok(json) = res.json::<serde_json::Value>().await {
                answered = true;
                let shelves_opt = json
                    .pointer(
                        "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents",
                    )
                    .or_else(|| {
                        json.pointer(
                            "/contents/twoColumnBrowseResultsRenderer/secondaryContents/sectionListRenderer/contents",
                        )
                    })
                    .or_else(|| {
                        json.pointer(
                            "/contents/twoColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents",
                        )
                    })
                    .and_then(|v| v.as_array());

                let mut sections = Vec::new();
                if let Some(shelves) = shelves_opt {
                    sections = parse_shelves(shelves);
                } else if let Some(grid) = json.pointer(
                    "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/gridRenderer",
                ) {
                    let section_title = grid
                        .pointer("/header/gridHeaderRenderer/title/runs/0/text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Playlists");
                    let mut items = Vec::new();
                    if let Some(grid_items) = grid.get("items").and_then(|v| v.as_array()) {
                        for item in grid_items {
                            if let Some(parsed) = parse_feed_item(item) {
                                items.push(parsed);
                            }
                        }
                    }
                    if !items.is_empty() {
                        sections.push(HomeSection {
                            title: section_title.to_string(),
                            items,
                        });
                    }
                }

                let continuation_token = json
                    .pointer(
                        "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer",
                    )
                    .and_then(|sl| extract_continuation_token(sl));

                if !sections.is_empty() {
                    return Ok(HomeFeedResponse {
                        sections,
                        continuation_token,
                    });
                }
            }
        }
    }

    if !answered {
        return Err("Library request failed".to_string());
    }
    Ok(HomeFeedResponse {
        sections: Vec::new(),
        continuation_token: None,
    })
}
