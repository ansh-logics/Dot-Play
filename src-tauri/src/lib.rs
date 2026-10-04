use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    #[serde(rename = "videoId")]
    pub video_id: String,
    pub title: String,
    pub artist: String,
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: String,
    #[serde(rename = "playlistId", skip_serializing_if = "Option::is_none")]
    pub playlist_id: Option<String>,
    #[serde(rename = "itemType", skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistTrack {
    #[serde(rename = "videoId")]
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub duration: String,
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistDetails {
    pub id: String,
    pub title: String,
    pub description: String,
    pub author: String,
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: String,
    #[serde(rename = "trackCount")]
    pub track_count: String,
    pub tracks: Vec<PlaylistTrack>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HomeSection {
    pub title: String,
    pub items: Vec<SearchResult>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HomeFeedResponse {
    pub sections: Vec<HomeSection>,
    #[serde(rename = "continuationToken", skip_serializing_if = "Option::is_none")]
    pub continuation_token: Option<String>,
}

#[derive(Default)]
pub struct SessionState {
    pub cookies: Mutex<Option<String>>,
    pub image_cache: Mutex<HashMap<String, String>>,
}

fn persist_session(app: &AppHandle, cookies: &str) -> Result<(), String> {
    if let Ok(app_data) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&app_data);
        let session_file = app_data.join("session.json");
        let data = serde_json::json!({ "cookies": cookies });
        std::fs::write(&session_file, data.to_string())
            .map_err(|e| format!("Failed to write session file: {}", e))?;
        println!("[DOT Music] Successfully persisted session to {:?}", session_file);
    }
    Ok(())
}

fn extract_cookie_value<'a>(cookies: &'a str, key: &str) -> Option<&'a str> {
    for part in cookies.split(';') {
        let trimmed = part.trim();
        if let Some((k, v)) = trimmed.split_once('=') {
            if k.trim() == key {
                return Some(v.trim());
            }
        }
    }
    None
}

fn generate_sapisid_hash(sapisid: &str, origin: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let payload = format!("{} {} {}", timestamp, sapisid, origin);
    let mut hasher = Sha1::new();
    hasher.update(payload.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    format!("{}_{}", timestamp, hash)
}

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
async fn search_tracks(query: String) -> Result<Vec<SearchResult>, String> {
    let clean_query = query.trim();
    if clean_query.is_empty() {
        return Ok(Vec::new());
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20240101.01.00"
            }
        },
        "query": clean_query
    });

    let res = client
        .post("https://music.youtube.com/youtubei/v1/search")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Referer", "https://music.youtube.com/")
        .header("Origin", "https://music.youtube.com")
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

        let mut artist_parts = Vec::new();
        if let Some(subtitle_runs) = card.pointer("/subtitle/runs").and_then(|v| v.as_array()) {
            for run in subtitle_runs {
                if let Some(txt) = run.get("text").and_then(|v| v.as_str()) {
                    artist_parts.push(txt);
                }
            }
        }
        let artist = if !artist_parts.is_empty() {
            artist_parts.join("")
        } else {
            "YouTube Music".to_string()
        };

        if let (Some(id), Some(t)) = (video_id, title) {
            results.push(SearchResult {
                video_id: id.to_string(),
                title: t.to_string(),
                artist,
                thumbnail_url: thumb.to_string(),
                playlist_id: None,
                item_type: Some("song".to_string()),
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

                        let artist = item_renderer
                            .pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs/0/text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Artist");

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
                            if !results.iter().any(|r| r.video_id == id) {
                                results.push(SearchResult {
                                    video_id: id.to_string(),
                                    title: t.to_string(),
                                    artist: artist.to_string(),
                                    thumbnail_url: thumb.to_string(),
                                    playlist_id: None,
                                    item_type: Some("song".to_string()),
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

#[cfg(target_os = "macos")]
fn trigger_native_cookie_sync(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("yt_login") {
        let app_handle = app.clone();
        let _ = win.with_webview(move |w| {
            use objc2::runtime::AnyObject;
            use objc2::rc::Retained;
            use objc2::msg_send;
            use block2::RcBlock;
            use std::ptr::NonNull;

            unsafe {
                let view = &*(w.inner() as *const AnyObject);
                let config: Retained<AnyObject> = msg_send![view, configuration];
                let data_store: Retained<AnyObject> = msg_send![&config, websiteDataStore];
                let cookie_store: Retained<AnyObject> = msg_send![&data_store, httpCookieStore];

                let app_cb = app_handle.clone();
                let block = RcBlock::new(move |cookies_ptr: NonNull<AnyObject>| {
                    let cookies = cookies_ptr.as_ptr();
                    let count: usize = msg_send![cookies, count];
                    let mut yt_cookie_map = std::collections::HashMap::new();
                    let mut google_cookie_map = std::collections::HashMap::new();
                    let mut has_login_info = false;
                    let mut has_yt_sapisid = false;
                    let mut has_google_sapisid = false;

                    for i in 0..count {
                        let cookie: Retained<AnyObject> = msg_send![cookies, objectAtIndex: i];
                        let name_ns: Retained<objc2_foundation::NSString> = msg_send![&cookie, name];
                        let val_ns: Retained<objc2_foundation::NSString> = msg_send![&cookie, value];
                        let domain_ns: Retained<objc2_foundation::NSString> = msg_send![&cookie, domain];

                        let name = name_ns.to_string();
                        let val = val_ns.to_string();
                        let domain = domain_ns.to_string();

                        if domain.contains("youtube.com") {
                            if name == "LOGIN_INFO" && !val.trim().is_empty() {
                                has_login_info = true;
                            }
                            if name == "SAPISID" || name == "__Secure-3PAPISID" {
                                has_yt_sapisid = true;
                            }
                            yt_cookie_map.insert(name.clone(), val.clone());
                        }

                        if domain.contains("google.com") {
                            if name == "SAPISID" || name == "__Secure-3PAPISID" {
                                has_google_sapisid = true;
                            }
                            google_cookie_map.insert(name, val);
                        }
                    }

                    // Strict YouTube authentication condition:
                    // YouTube MUST have issued LOGIN_INFO, plus valid SAPISID
                    let is_authenticated = has_login_info && (has_yt_sapisid || has_google_sapisid);

                    if is_authenticated {
                        // Merge cookies with YouTube cookies taking highest priority
                        let mut final_map = google_cookie_map;
                        for (k, v) in yt_cookie_map {
                            final_map.insert(k, v);
                        }

                        let full_cookie_str = final_map
                            .into_iter()
                            .map(|(k, v)| format!("{}={}", k, v))
                            .collect::<Vec<_>>()
                            .join("; ");

                        println!(
                            "[DOT Music] Successfully verified YouTube authentication (has_login_info=true, cookies_count={}, bytes={})",
                            count, full_cookie_str.len()
                        );

                        let app = app_cb.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Some(win) = app.get_webview_window("yt_login") {
                                let _ = win.hide();
                                let _ = win.destroy();
                            }
                            if let Some(state) = app.try_state::<SessionState>() {
                                *state.cookies.lock().unwrap() = Some(full_cookie_str.clone());
                            }
                            let _ = persist_session(&app, &full_cookie_str);
                            let _ = app.emit("login_success", ());
                        });
                    }
                });

                let _: () = msg_send![&cookie_store, getAllCookies: &*block];
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
fn trigger_native_cookie_sync(_app: &AppHandle) {}

fn attach_youtube_auth(mut req: reqwest::RequestBuilder, cookies_opt: &Option<String>) -> reqwest::RequestBuilder {
    if let Some(cookies) = cookies_opt {
        req = req.header("Cookie", cookies);
        let sapisid_opt = extract_cookie_value(cookies, "SAPISID")
            .or_else(|| extract_cookie_value(cookies, "__Secure-3PAPISID"))
            .or_else(|| extract_cookie_value(cookies, "__Secure-1PAPISID"));
        if let Some(sapisid) = sapisid_opt {
            let auth = generate_sapisid_hash(sapisid, "https://music.youtube.com");
            req = req.header("Authorization", format!("SAPISIDHASH {}", auth));
            req = req.header("X-Origin", "https://music.youtube.com");
            req = req.header("X-Goog-AuthUser", "0");
        }
    }
    req
}

#[tauri::command]
async fn open_login_window(app: AppHandle, clean: Option<bool>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("yt_login") {
        let _ = existing.set_focus();
        return Ok(());
    }

    if clean.unwrap_or(false) {
        clear_native_webkit_data(&app);
    }

    let url = "https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fmusic.youtube.com%2F&prompt=select_account&hl=en"
        .parse()
        .map_err(|e| format!("Invalid URL: {}", e))?;

    let init_script = r#"
        (function() {
            function checkInterstitial() {
                var host = window.location.hostname;
                // Only auto-forward if landed on Google Account settings detour (not during sign-in)
                if (host.includes('myaccount.google.com')) {
                    window.location.href = 'https://music.youtube.com/';
                }
            }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', checkInterstitial);
            } else {
                checkInterstitial();
            }
            setInterval(checkInterstitial, 1000);
        })();
    "#;

    let app_nav_handle = app.clone();
    let login_window = WebviewWindowBuilder::new(&app, "yt_login", WebviewUrl::External(url))
        .title("Sign in to YouTube Music")
        .inner_size(520.0, 700.0)
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        )
        .initialization_script(init_script)
        .on_navigation(move |nav_url| {
            let host = nav_url.host_str().unwrap_or("");
            if host == "music.youtube.com" || host.ends_with(".music.youtube.com") {
                // Instantly hide the window upon entering YouTube Music so user never sees web player
                if let Some(win) = app_nav_handle.get_webview_window("yt_login") {
                    let _ = win.hide();
                }
                trigger_native_cookie_sync(&app_nav_handle);
            } else if host.ends_with(".youtube.com") || host == "myaccount.google.com" {
                trigger_native_cookie_sync(&app_nav_handle);
            }
            true
        })
        .build()
        .map_err(|e| format!("Failed to create login window: {}", e))?;

    // Continuous heartbeat while yt_login is open (poll every 400ms for instant completion)
    let app_poll_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..750 {
            std::thread::sleep(std::time::Duration::from_millis(400));
            if app_poll_handle.get_webview_window("yt_login").is_some() {
                trigger_native_cookie_sync(&app_poll_handle);
            } else {
                break;
            }
        }
    });

    let app_close_handle = app.clone();
    login_window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            if let Some(state) = app_close_handle.try_state::<SessionState>() {
                let guard = state.cookies.lock().unwrap();
                if guard.is_none() {
                    let _ = app_close_handle.emit("login_cancelled", ());
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn save_session(
    app: AppHandle,
    state: State<'_, SessionState>,
    cookies: String,
) -> Result<(), String> {
    if cookies.contains("LOGIN_INFO") && (cookies.contains("SAPISID") || cookies.contains("__Secure-3PAPISID")) {
        *state.cookies.lock().unwrap() = Some(cookies.clone());
        let _ = persist_session(&app, &cookies);

        if let Some(win) = app.get_webview_window("yt_login") {
            let _ = win.hide();
            let _ = win.destroy();
        }

        let _ = app.emit("login_success", ());
        Ok(())
    } else {
        Err("Incomplete cookies: missing LOGIN_INFO".to_string())
    }
}

#[tauri::command]
async fn get_auth_status(state: State<'_, SessionState>) -> Result<bool, String> {
    let guard = state.cookies.lock().unwrap();
    if let Some(ref cookies) = *guard {
        Ok(cookies.contains("LOGIN_INFO") && (cookies.contains("SAPISID") || cookies.contains("__Secure-3PAPISID")))
    } else {
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
fn clear_native_webkit_data(_app: &AppHandle) {
    use objc2::runtime::AnyObject;
    use objc2::rc::Retained;
    use objc2::msg_send;
    use block2::RcBlock;

    unsafe {
        let data_store: Retained<AnyObject> = msg_send![objc2::class!(WKWebsiteDataStore), defaultDataStore];
        let data_types: Retained<AnyObject> = msg_send![objc2::class!(WKWebsiteDataStore), allWebsiteDataTypes];
        let date_past: Retained<AnyObject> = msg_send![objc2::class!(NSDate), distantPast];

        let block = RcBlock::new(|| {
            println!("[DOT Music] All WebKit website data, cookies, and cache cleared!");
        });

        let _: () = msg_send![
            &data_store,
            removeDataOfTypes: &*data_types,
            modifiedSince: &*date_past,
            completionHandler: &*block
        ];
    }
}

#[cfg(not(target_os = "macos"))]
fn clear_native_webkit_data(_app: &AppHandle) {}

#[tauri::command]
async fn logout(app: AppHandle, state: State<'_, SessionState>) -> Result<(), String> {
    {
        let mut guard = state.cookies.lock().unwrap();
        *guard = None;
    }

    // Delete session file from disk
    if let Ok(app_data) = app.path().app_data_dir() {
        let session_file = app_data.join("session.json");
        let _ = std::fs::remove_file(session_file);
    }

    clear_native_webkit_data(&app);

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserProfile {
    pub name: String,
    pub email: String,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: String,
}

#[tauri::command]
async fn get_user_profile(state: State<'_, SessionState>) -> Result<Option<UserProfile>, String> {
    let maybe_cookies = state.cookies.lock().unwrap().clone();
    if maybe_cookies.is_none() {
        return Ok(None);
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20240101.01.00"
            }
        }
    });

    let mut request = client
        .post("https://music.youtube.com/youtubei/v1/account/account_menu")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Referer", "https://music.youtube.com/")
        .header("Origin", "https://music.youtube.com")
        .json(&body);

    request = attach_youtube_auth(request, &maybe_cookies);

    let res = match request.send().await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };

    let json: serde_json::Value = match res.json().await {
        Ok(j) => j,
        Err(_) => return Ok(None),
    };

    let header_opt = json.pointer("/actions/0/openPopupAction/popup/multiPageMenuRenderer/header/activeAccountHeaderRenderer");
    if let Some(h) = header_opt {
        let name = h.pointer("/accountName/runs/0/text")
            .or_else(|| h.pointer("/channelHandle/runs/0/text"))
            .and_then(|v| v.as_str())
            .unwrap_or("User")
            .to_string();

        let email = h.pointer("/email/runs/0/text")
            .or_else(|| h.pointer("/channelHandle/runs/0/text"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let raw_avatar = h.pointer("/accountPhoto/thumbnails")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.last().or_else(|| arr.first()))
            .and_then(|t| t.get("url"))
            .and_then(|u| u.as_str())
            .unwrap_or("");

        let avatar_url = upscale_thumbnail_url(raw_avatar);

        return Ok(Some(UserProfile {
            name,
            email,
            avatar_url,
        }));
    }

    Ok(None)
}

pub fn upscale_thumbnail_url(raw_url: &str) -> String {
    if raw_url.is_empty() {
        return String::new();
    }
    if raw_url.contains("googleusercontent.com") || raw_url.contains("ggpht.com") {
        if let Some(idx) = raw_url.rfind("=w") {
            let base = &raw_url[..idx];
            return format!("{}=w800-h800-l90-rj", base);
        } else if let Some(idx) = raw_url.rfind("=s") {
            let base = &raw_url[..idx];
            return format!("{}=s800-l90-rj", base);
        }
    }
    raw_url.to_string()
}

fn parse_feed_item(item: &serde_json::Value) -> Option<SearchResult> {
    let renderer = item.get("musicTwoRowItemRenderer")
        .or_else(|| item.get("musicResponsiveListItemRenderer"))?;

    // 1. Extract Title
    let title = renderer
        .pointer("/title/runs/0/text")
        .or_else(|| renderer.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/text"))
        .and_then(|v| v.as_str())?;

    // 2. Extract Artist / Subtitle
    let mut subtitle_parts = Vec::new();
    let subtitle_runs_opt = renderer.pointer("/subtitle/runs")
        .or_else(|| renderer.pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs"))
        .and_then(|v| v.as_array());

    if let Some(runs) = subtitle_runs_opt {
        for run in runs {
            if let Some(txt) = run.get("text").and_then(|v| v.as_str()) {
                subtitle_parts.push(txt);
            }
        }
    }
    let artist = if !subtitle_parts.is_empty() {
        subtitle_parts.join("")
    } else {
        "YouTube Music".to_string()
    };

    // 3. Extract Thumbnail
    let raw_thumb = renderer
        .pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails")
        .or_else(|| renderer.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails"))
        .or_else(|| renderer.pointer("/thumbnail/thumbnails"))
        .or_else(|| renderer.pointer("/thumbnailRenderer/thumbnails"))
        .or_else(|| renderer.pointer("/thumbnail/croppedSquareThumbnailRenderer/thumbnail/thumbnails"))
        .or_else(|| renderer.pointer("/thumbnails"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.last().or_else(|| arr.first()))
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("");
    let thumb = upscale_thumbnail_url(raw_thumb);

    // Subtitle type flags
    let is_song_subtitle = subtitle_parts.iter().any(|p| {
        let t = p.trim();
        t.eq_ignore_ascii_case("Song") || t.eq_ignore_ascii_case("Video")
    }) || artist.trim().starts_with("Song •") 
       || artist.trim().starts_with("Song ·")
       || artist.trim().starts_with("Video •")
       || artist.trim().starts_with("Video ·");

    let is_playlist_or_album_subtitle = subtitle_parts.iter().any(|p| {
        let t = p.trim();
        t.eq_ignore_ascii_case("Playlist")
            || t.eq_ignore_ascii_case("Featured Playlist")
            || t.eq_ignore_ascii_case("Community Playlist")
            || t.eq_ignore_ascii_case("Album")
            || t.eq_ignore_ascii_case("EP")
            || t.eq_ignore_ascii_case("Single")
    }) || artist.trim().starts_with("Playlist •") 
       || artist.trim().starts_with("Playlist ·")
       || artist.trim().starts_with("Album •")
       || artist.trim().starts_with("Album ·")
       || artist.trim().starts_with("EP •")
       || artist.trim().starts_with("EP ·")
       || artist.trim().starts_with("Single •")
       || artist.trim().starts_with("Single ·");

    // 4. Primary card watch endpoint (indicates card clicks directly to play a song/video)
    let card_watch = renderer.pointer("/navigationEndpoint/watchEndpoint")
        .or_else(|| renderer.pointer("/title/runs/0/navigationEndpoint/watchEndpoint"))
        .or_else(|| renderer.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint"));

    let card_watch_video_id = card_watch.and_then(|w| w.get("videoId")).and_then(|v| v.as_str());
    let card_watch_playlist_id = card_watch.and_then(|w| w.get("playlistId")).and_then(|v| v.as_str());

    // 5. Primary card browse endpoint (indicates card clicks to open a playlist, album, or artist)
    let browse_endpoint = renderer.pointer("/navigationEndpoint/browseEndpoint")
        .or_else(|| renderer.pointer("/title/runs/0/navigationEndpoint/browseEndpoint"))
        .or_else(|| renderer.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/browseEndpoint"));

    let browse_id = browse_endpoint.and_then(|b| b.get("browseId")).and_then(|v| v.as_str());
    let browse_page_type = browse_endpoint
        .and_then(|b| b.pointer("/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType"))
        .and_then(|v| v.as_str());

    // 6. Thumbnail overlay (play button on thumbnail)
    let overlay_watch = renderer.pointer("/thumbnailOverlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint")
        .or_else(|| renderer.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint"));

    let overlay_watch_video_id = overlay_watch.and_then(|w| w.get("videoId")).and_then(|v| v.as_str());
    let overlay_watch_playlist_id = overlay_watch.and_then(|w| w.get("playlistId")).and_then(|v| v.as_str());

    let playlist_item_video_id = renderer.pointer("/playlistItemData/videoId").and_then(|v| v.as_str());

    // Resolve playlist ID
    let mut resolved_playlist_id: Option<String> = None;
    let is_playlist_browse = if let Some(bid) = browse_id {
        let is_known_type = browse_page_type == Some("MUSIC_PAGE_TYPE_PLAYLIST")
            || browse_page_type == Some("MUSIC_PAGE_TYPE_ALBUM")
            || browse_page_type == Some("MUSIC_PAGE_TYPE_ARTIST");

        if bid.starts_with("VL") {
            resolved_playlist_id = Some(bid[2..].to_string());
            true
        } else if bid.starts_with("PL")
            || bid.starts_with("RDCL")
            || bid.starts_with("MPRE")
            || bid.starts_with("OLAK")
            || bid.starts_with("FEmusic_")
        {
            resolved_playlist_id = Some(bid.to_string());
            true
        } else if is_known_type {
            resolved_playlist_id = Some(bid.to_string());
            true
        } else {
            false
        }
    } else {
        false
    };

    if resolved_playlist_id.is_none() {
        if let Some(pid) = overlay_watch_playlist_id.or(card_watch_playlist_id) {
            resolved_playlist_id = Some(pid.to_string());
        }
    }

    // Resolve video ID
    let resolved_video_id = card_watch_video_id
        .or(playlist_item_video_id)
        .or(overlay_watch_video_id)
        .unwrap_or("");

    // Determine whether this item is a playlist or a song
    let is_playlist = if is_song_subtitle {
        false
    } else if is_playlist_or_album_subtitle {
        true
    } else if is_playlist_browse {
        true
    } else if card_watch_video_id.is_some() {
        false
    } else if !resolved_video_id.is_empty() && (resolved_playlist_id.is_none() || resolved_playlist_id.as_ref().map(|p| p.starts_with("RDAMVM")).unwrap_or(false)) {
        false
    } else if resolved_playlist_id.is_some() && resolved_video_id.is_empty() {
        true
    } else {
        resolved_video_id.is_empty() && resolved_playlist_id.is_some()
    };

    let item_type = if is_playlist { "playlist" } else { "song" };

    let final_playlist_id = if is_playlist {
        resolved_playlist_id
    } else {
        // If it's a song, only keep playlist_id if it's a real standard playlist (PL...), not an auto-radio mix (RDAMVM...)
        resolved_playlist_id.filter(|p| p.starts_with("PL"))
    };

    if !resolved_video_id.is_empty() || final_playlist_id.is_some() {
        let final_thumb = if !thumb.is_empty() {
            thumb
        } else if !resolved_video_id.is_empty() {
            format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", resolved_video_id)
        } else {
            String::new()
        };

        Some(SearchResult {
            video_id: resolved_video_id.to_string(),
            title: title.to_string(),
            artist,
            thumbnail_url: final_thumb,
            playlist_id: final_playlist_id,
            item_type: Some(item_type.to_string()),
        })
    } else {
        None
    }
}

fn extract_continuation_token(value: &serde_json::Value) -> Option<String> {
    // 1. Try direct continuations array
    if let Some(token) = value.pointer("/continuations/0/nextContinuationData/continuation")
        .and_then(|v| v.as_str()) {
        return Some(token.to_string());
    }

    // 2. Try sectionListContinuation
    if let Some(token) = value.pointer("/continuationContents/sectionListContinuation/continuations/0/nextContinuationData/continuation")
        .and_then(|v| v.as_str()) {
        return Some(token.to_string());
    }

    // 3. Try continuationItemRenderer in contents array
    let contents_opt = value.pointer("/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents")
        .or_else(|| value.pointer("/continuationContents/sectionListContinuation/contents"))
        .or_else(|| value.pointer("/contents"))
        .and_then(|v| v.as_array());

    if let Some(contents) = contents_opt {
        for item in contents.iter().rev() {
            if let Some(token) = item.pointer("/continuationItemRenderer/continuationEndpoint/continuationCommand/token")
                .and_then(|v| v.as_str()) {
                return Some(token.to_string());
            }
        }
    }

    None
}

fn parse_shelves(shelves: &[serde_json::Value]) -> Vec<HomeSection> {
    let mut sections = Vec::new();

    for shelf in shelves {
        // Handle itemSectionRenderer wrappers
        if let Some(inner_contents) = shelf.pointer("/itemSectionRenderer/contents").and_then(|v| v.as_array()) {
            let inner_sections = parse_shelves(inner_contents);
            sections.extend(inner_sections);
            continue;
        }

        // 1. Horizontal Carousel Shelves (Featured playlists, Romance Right Now, Quick picks, etc.)
        if let Some(carousel) = shelf.get("musicCarouselShelfRenderer") {
            let section_title = carousel
                .pointer("/header/musicCarouselShelfBasicHeaderRenderer/title/runs/0/text")
                .or_else(|| carousel.pointer("/header/musicCarouselShelfBasicHeaderRenderer/strapline/runs/0/text"))
                .and_then(|v| v.as_str())
                .unwrap_or("Featured");

            let mut items = Vec::new();
            if let Some(carousel_items) = carousel.get("contents").and_then(|v| v.as_array()) {
                for item in carousel_items {
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
        // 2. Vertical Shelves (Songs, Quick picks list, History date groups, etc.)
        else if let Some(music_shelf) = shelf.get("musicShelfRenderer") {
            let section_title = music_shelf
                .pointer("/title/runs/0/text")
                .or_else(|| music_shelf.pointer("/header/musicShelfHeaderRenderer/title/runs/0/text"))
                .or_else(|| music_shelf.pointer("/header/musicHeaderRenderer/title/runs/0/text"))
                .or_else(|| music_shelf.pointer("/bottomEndpoint/searchEndpoint/query"))
                .and_then(|v| v.as_str())
                .unwrap_or("History");

            let mut items = Vec::new();
            if let Some(shelf_items) = music_shelf.get("contents").and_then(|v| v.as_array()) {
                for item in shelf_items {
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
        // 3. Grid Shelves (Library playlists, albums grid, etc.)
        else if let Some(grid) = shelf.get("gridRenderer") {
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
    }

    sections
}

#[tauri::command]
async fn get_home_feed(state: State<'_, SessionState>) -> Result<HomeFeedResponse, String> {
    let client = reqwest::Client::new();
    let maybe_cookies = state.cookies.lock().unwrap().clone();

    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20240101.01.00"
            }
        },
        "browseId": "FEmusic_home"
    });

    let mut request = client
        .post("https://music.youtube.com/youtubei/v1/browse")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Referer", "https://music.youtube.com/")
        .header("Origin", "https://music.youtube.com");

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
    let trending = search_tracks("trending music 2026".to_string()).await.unwrap_or_default();
    let chill = search_tracks("lofi chill beats".to_string()).await.unwrap_or_default();

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
async fn get_home_feed_continuation(
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

    let client = reqwest::Client::new();
    let maybe_cookies = state.cookies.lock().unwrap().clone();

    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20240101.01.00"
            }
        },
        "continuation": clean_continuation
    });

    let url = format!(
        "https://music.youtube.com/youtubei/v1/browse?continuation={}&ctoken={}",
        clean_continuation, clean_continuation
    );

    let mut request = client
        .post(&url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Referer", "https://music.youtube.com/")
        .header("Origin", "https://music.youtube.com");

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
async fn get_history(state: State<'_, SessionState>) -> Result<HomeFeedResponse, String> {
    let maybe_cookies = state.cookies.lock().unwrap().clone();
    if maybe_cookies.is_none() {
        return Ok(HomeFeedResponse {
            sections: Vec::new(),
            continuation_token: None,
        });
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20240101.01.00"
            }
        },
        "browseId": "FEmusic_history"
    });

    let mut request = client
        .post("https://music.youtube.com/youtubei/v1/browse")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Referer", "https://music.youtube.com/")
        .header("Origin", "https://music.youtube.com");

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

            return Ok(HomeFeedResponse {
                sections,
                continuation_token,
            });
        }
    }

    Ok(HomeFeedResponse {
        sections: Vec::new(),
        continuation_token: None,
    })
}

#[tauri::command]
async fn record_playback(
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
        let client = reqwest::Client::new();
        let player_body = serde_json::json!({
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": "1.20240101.01.00"
                }
            },
            "videoId": video_id
        });

        let mut req = client
            .post("https://music.youtube.com/youtubei/v1/player")
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            .header("Referer", "https://music.youtube.com/")
            .header("Origin", "https://music.youtube.com");

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
            let mut ping_req = client
                .get(&ping_url)
                .header(
                    reqwest::header::USER_AGENT,
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                )
                .header("Referer", "https://music.youtube.com/")
                .header("Origin", "https://music.youtube.com");
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
            let mut ping_req = client
                .get(&ping_url)
                .header(
                    reqwest::header::USER_AGENT,
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                )
                .header("Referer", "https://music.youtube.com/")
                .header("Origin", "https://music.youtube.com");
            ping_req = attach_youtube_auth(ping_req, &maybe_cookies);
            if let Ok(resp) = ping_req.send().await {
                println!("[DOT Music] videostatsWatchtimeUrl ping status: {}", resp.status());
            }
        }

        // 3. ATR ping
        if let Some(base_url) = atr_url {
            let sep = if base_url.contains('?') { '&' } else { '?' };
            let ping_url = format!("{}{}cpn={}", base_url, sep, cpn);
            let mut ping_req = client
                .get(&ping_url)
                .header(
                    reqwest::header::USER_AGENT,
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                )
                .header("Referer", "https://music.youtube.com/")
                .header("Origin", "https://music.youtube.com");
            ping_req = attach_youtube_auth(ping_req, &maybe_cookies);
            let _ = ping_req.send().await;
        }
    });

    Ok(true)
}

#[tauri::command]
async fn get_library_playlists(state: State<'_, SessionState>) -> Result<HomeFeedResponse, String> {
    let maybe_cookies = state.cookies.lock().unwrap().clone();
    if maybe_cookies.is_none() {
        return Ok(HomeFeedResponse {
            sections: Vec::new(),
            continuation_token: None,
        });
    }

    let client = reqwest::Client::new();
    let browse_ids = ["FEmusic_liked_playlists", "FEmusic_library_landing"];

    for browse_id in browse_ids {
        let body = serde_json::json!({
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": "1.20240101.01.00"
                }
            },
            "browseId": browse_id
        });

        let mut request = client
            .post("https://music.youtube.com/youtubei/v1/browse")
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            .header("Referer", "https://music.youtube.com/")
            .header("Origin", "https://music.youtube.com");

        request = attach_youtube_auth(request, &maybe_cookies);

        if let Ok(res) = request.json(&body).send().await {
            if let Ok(json) = res.json::<serde_json::Value>().await {
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

    Ok(HomeFeedResponse {
        sections: Vec::new(),
        continuation_token: None,
    })
}

#[tauri::command]
async fn get_playlist_details(
    state: State<'_, SessionState>,
    playlist_id: String,
) -> Result<PlaylistDetails, String> {
    let clean_id = playlist_id.trim();
    if clean_id.is_empty() {
        return Err("Playlist ID cannot be empty".to_string());
    }

    let client = reqwest::Client::new();
    let maybe_cookies = state.cookies.lock().unwrap().clone();

    let browse_id = if clean_id.starts_with("VL") || clean_id.starts_with("MPRE") {
        clean_id.to_string()
    } else {
        format!("VL{}", clean_id)
    };

    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20240101.01.00"
            }
        },
        "browseId": browse_id
    });

    let mut request = client
        .post("https://music.youtube.com/youtubei/v1/browse")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Referer", "https://music.youtube.com/")
        .header("Origin", "https://music.youtube.com");

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

                let mut track_artist_parts = Vec::new();
                if let Some(runs) = r.pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs").and_then(|v| v.as_array()) {
                    for run in runs {
                        if let Some(txt) = run.get("text").and_then(|v| v.as_str()) {
                            track_artist_parts.push(txt);
                        }
                    }
                }
                let track_artist = if !track_artist_parts.is_empty() {
                    track_artist_parts.join("")
                } else {
                    "Artist".to_string()
                };

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
                    tracks.push(PlaylistTrack {
                        video_id: id.to_string(),
                        title: t.to_string(),
                        artist: track_artist,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct ThumbnailQuery {
    #[serde(rename = "videoId")]
    pub video_id: String,
    #[serde(rename = "currentUrl")]
    pub current_url: String,
}

#[tauri::command]
async fn get_highres_thumbnails(
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

            if let Some(cached_url) = cache.get(&key) {
                results.insert(key, cached_url.clone());
            } else {
                to_probe.push(track);
            }
        }
    }

    if to_probe.is_empty() {
        return Ok(results);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();

    let mut handles = Vec::new();

    for track in to_probe {
        let client_clone = client.clone();
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

            // 1. Probe maxresdefault.jpg (1080p master)
            let maxres = format!("https://i.ytimg.com/vi/{}/maxresdefault.jpg", track.video_id);
            if let Ok(res) = client_clone.head(&maxres).send().await {
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
            if let Ok(res) = client_clone.head(&sddefault).send().await {
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct QueueSession {
    pub history: Vec<SearchResult>,
    #[serde(rename = "currentTrack")]
    pub current_track: Option<SearchResult>,
    pub upcoming: Vec<SearchResult>,
    #[serde(rename = "currentTime")]
    pub current_time: f64,
    #[serde(rename = "isAutoplay")]
    pub is_autoplay: bool,
}

#[tauri::command]
async fn save_queue_session(app: AppHandle, session: QueueSession) -> Result<bool, String> {
    if let Ok(app_data) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&app_data);
        let queue_file = app_data.join("queue_session.json");
        let tmp_file = app_data.join("queue_session.json.tmp");
        let data = serde_json::to_string_pretty(&session)
            .map_err(|e| format!("Failed to serialize queue session: {}", e))?;
        std::fs::write(&tmp_file, data)
            .map_err(|e| format!("Failed to write tmp queue session: {}", e))?;
        std::fs::rename(&tmp_file, &queue_file)
            .map_err(|e| format!("Failed to atomically rename queue session: {}", e))?;
        return Ok(true);
    }
    Err("Could not access app data directory".to_string())
}

#[tauri::command]
async fn get_queue_session(app: AppHandle) -> Result<Option<QueueSession>, String> {
    if let Ok(app_data) = app.path().app_data_dir() {
        let queue_file = app_data.join("queue_session.json");
        if queue_file.exists() {
            if let Ok(contents) = std::fs::read_to_string(&queue_file) {
                if let Ok(session) = serde_json::from_str::<QueueSession>(&contents) {
                    return Ok(Some(session));
                } else {
                    eprintln!("[DOT Music] queue_session.json was malformed, ignoring.");
                }
            }
        }
    }
    Ok(None)
}

#[tauri::command]
async fn get_related_recommendation(
    state: State<'_, SessionState>,
    video_id: String,
) -> Result<Option<SearchResult>, String> {
    let clean_id = video_id.trim();
    if clean_id.is_empty() {
        return Ok(None);
    }

    let client = reqwest::Client::new();
    let maybe_cookies = state.cookies.lock().unwrap().clone();

    let body = serde_json::json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": "1.20240101.01.00"
            }
        },
        "videoId": clean_id,
        "isAudioOnly": true
    });

    let mut request = client
        .post("https://music.youtube.com/youtubei/v1/next")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Referer", "https://music.youtube.com/")
        .header("Origin", "https://music.youtube.com");

    request = attach_youtube_auth(request, &maybe_cookies);

    if let Ok(res) = request.json(&body).send().await {
        if let Ok(json) = res.json::<serde_json::Value>().await {
            let queue_contents = json
                .pointer("/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs/0/tabRenderer/content/musicQueueRenderer/content/playlistPanelRenderer/contents")
                .and_then(|v| v.as_array());

            if let Some(items) = queue_contents {
                for item in items {
                    if let Some(r) = item.get("playlistPanelVideoRenderer") {
                        let vid = r.get("videoId").and_then(|v| v.as_str()).unwrap_or("");
                        if !vid.is_empty() && vid != clean_id {
                            let title = r.pointer("/title/runs/0/text").and_then(|v| v.as_str()).unwrap_or("Unknown Title");
                            let mut artist_parts = Vec::new();
                            if let Some(runs) = r.pointer("/longBylineText/runs").or_else(|| r.pointer("/shortBylineText/runs")).and_then(|v| v.as_array()) {
                                for run in runs {
                                    if let Some(txt) = run.get("text").and_then(|t| t.as_str()) {
                                        artist_parts.push(txt);
                                    }
                                }
                            }
                            let artist = if !artist_parts.is_empty() {
                                artist_parts.join("")
                            } else {
                                "Artist".to_string()
                            };

                            let thumb = r.pointer("/thumbnail/thumbnails")
                                .and_then(|arr| arr.as_array())
                                .and_then(|arr| arr.last().or_else(|| arr.first()))
                                .and_then(|t| t.get("url"))
                                .and_then(|u| u.as_str())
                                .unwrap_or("");

                            let final_thumb = if !thumb.is_empty() {
                                upscale_thumbnail_url(thumb)
                            } else {
                                format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", vid)
                            };

                            return Ok(Some(SearchResult {
                                video_id: vid.to_string(),
                                title: title.to_string(),
                                artist,
                                thumbnail_url: final_thumb,
                                playlist_id: None,
                                item_type: Some("song".to_string()),
                            }));
                        }
                    }
                }
            }
        }
    }

    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionState::default())
        .plugin(tauri_plugin_log::Builder::default().build())
        .setup(|app| {
            // Restore saved session & image cache from disk on startup
            if let Ok(app_data) = app.path().app_data_dir() {
                let session_file = app_data.join("session.json");
                if session_file.exists() {
                    if let Ok(contents) = std::fs::read_to_string(&session_file) {
                        if let Ok(saved) = serde_json::from_str::<serde_json::Value>(&contents) {
                            if let Some(cookies) = saved.get("cookies").and_then(|c| c.as_str()) {
                                if cookies.contains("LOGIN_INFO") && (cookies.contains("SAPISID") || cookies.contains("__Secure-3PAPISID")) {
                                    let state = app.state::<SessionState>();
                                    *state.cookies.lock().unwrap() = Some(cookies.to_string());
                                } else {
                                    // Session on disk is incomplete or missing LOGIN_INFO - wipe it clean!
                                    let _ = std::fs::remove_file(&session_file);
                                }
                            }
                        }
                    }
                }

                let image_cache_file = app_data.join("image_cache.json");
                if image_cache_file.exists() {
                    if let Ok(contents) = std::fs::read_to_string(image_cache_file) {
                        if let Ok(cached) = serde_json::from_str::<HashMap<String, String>>(&contents) {
                            let state = app.state::<SessionState>();
                            *state.image_cache.lock().unwrap() = cached;
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_tracks,
            open_login_window,
            save_session,
            get_auth_status,
            logout,
            get_home_feed,
            get_home_feed_continuation,
            get_playlist_details,
            get_highres_thumbnails,
            get_user_profile,
            get_history,
            get_library_playlists,
            record_playback,
            save_queue_session,
            get_queue_session,
            get_related_recommendation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

