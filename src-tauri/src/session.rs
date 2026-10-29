//! The signed-in YouTube session: cookie state and its persistence, the Google sign-in
//! window (with native WKWebView cookie sync on macOS), logout, auth status and the
//! account profile.

use crate::ytmusic::parse::upscale_thumbnail_url;
use crate::ytmusic::{attach_youtube_auth, web_remix_context, with_ytm_headers, HTTP_CLIENT, SAFARI_USER_AGENT};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct SessionState {
    pub cookies: Mutex<Option<String>>,
    pub image_cache: Mutex<HashMap<String, String>>,
}

/// Set once a sign-in has been verified, until the next login window opens.
static LOGIN_COMPLETING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn persist_session(app: &AppHandle, cookies: &str) -> Result<(), String> {
    if let Ok(app_data) = app.path().app_data_dir() {
        let session_file = app_data.join("session.json");
        let data = serde_json::json!({ "cookies": cookies });
        // Atomic and owner-only: these are the account's sign-in cookies.
        crate::fsutil::write_atomic(&session_file, data.to_string().as_bytes(), true)
            .map_err(|e| format!("Failed to write session file: {}", e))?;
        println!("[DOT Music] Successfully persisted session to {:?}", session_file);
    }
    Ok(())
}

/// Restores the saved session and image cache from disk on startup.
pub(crate) fn restore_saved_state(app: &tauri::App) {
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
                            if name == "SAPISID" || name == "__Secure-3PAPISID" || name == "__Secure-1PAPISID" {
                                has_yt_sapisid = true;
                            }
                            yt_cookie_map.insert(name.clone(), val.clone());
                        }

                        if domain.contains("google.com") {
                            if name == "SAPISID" || name == "__Secure-3PAPISID" || name == "__Secure-1PAPISID" {
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

                        // Cookie sync runs on every tick, navigation and page load; only the
                        // first authenticated pass finishes the sign-in.
                        if LOGIN_COMPLETING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                            return;
                        }
                        let app = app_cb.clone();
                        tauri::async_runtime::spawn(async move {
                            // Update session state FIRST so any window close events see authenticated session
                            if let Some(state) = app.try_state::<SessionState>() {
                                *state.cookies.lock().unwrap() = Some(full_cookie_str.clone());
                            }
                            let _ = persist_session(&app, &full_cookie_str);

                            // Emit success events immediately to all listeners
                            let _ = app.emit("login_success", ());
                            let _ = app.emit_to("main", "login_success", ());

                            // Only now close and destroy the login window
                            if let Some(win) = app.get_webview_window("yt_login") {
                                let _ = win.hide();
                                let _ = win.destroy();
                            }
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

#[tauri::command]
pub(crate) async fn open_login_window(app: AppHandle, _clean: Option<bool>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("yt_login") {
        let _ = existing.set_focus();
        return Ok(());
    }
    // The login window is incognito, so every sign-in starts clean; `_clean` is unused.
    LOGIN_COMPLETING.store(false, std::sync::atomic::Ordering::SeqCst);

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
    let app_page_handle = app.clone();
    let login_window = WebviewWindowBuilder::new(&app, "yt_login", WebviewUrl::External(url))
        .title("Sign in to YouTube Music")
        .inner_size(520.0, 700.0)
        // Keep Google login cookies isolated from the app's persisted API session.
        // DOT Music stores only the verified cookies it needs in session.json.
        .incognito(true)
        .user_agent(SAFARI_USER_AGENT)
        .initialization_script(init_script)
        .on_navigation(move |nav_url| {
            let host = nav_url.host_str().unwrap_or("");
            if host == "music.youtube.com"
                || host.ends_with(".music.youtube.com")
                || host.ends_with(".youtube.com")
                || host == "myaccount.google.com"
            {
                trigger_native_cookie_sync(&app_nav_handle);
            }
            true
        })
        .on_page_load(move |_url, _payload| {
            trigger_native_cookie_sync(&app_page_handle);
        })
        .build()
        .map_err(|e| format!("Failed to create login window: {}", e))?;

    // Continuous heartbeat while yt_login is open (poll every 250ms for instant completion)
    let app_poll_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..1200 {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
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
                    let _ = app_close_handle.emit_to("main", "login_cancelled", ());
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub(crate) async fn save_session(
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
        let _ = app.emit_to("main", "login_success", ());
        Ok(())
    } else {
        Err("Incomplete cookies: missing LOGIN_INFO".to_string())
    }
}

#[tauri::command]
pub(crate) async fn get_auth_status(state: State<'_, SessionState>) -> Result<bool, String> {
    let guard = state.cookies.lock().unwrap();
    if let Some(ref cookies) = *guard {
        Ok(cookies.contains("LOGIN_INFO") && (cookies.contains("SAPISID") || cookies.contains("__Secure-3PAPISID")))
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub(crate) async fn logout(app: AppHandle, state: State<'_, SessionState>) -> Result<(), String> {
    {
        let mut guard = state.cookies.lock().unwrap();
        *guard = None;
    }

    // session.json is DOT Music's only persisted authentication record.
    // Removing it is safe; the app must treat a missing session as signed out.
    if let Ok(app_data) = app.path().app_data_dir() {
        let session_file = app_data.join("session.json");
        if session_file.exists() {
            let _ = std::fs::remove_file(&session_file);
        }
        let tmp_file = app_data.join("session.json.tmp");
        if tmp_file.exists() {
            let _ = std::fs::remove_file(&tmp_file);
        }
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserProfile {
    pub name: String,
    pub email: String,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: String,
}

fn find_active_account_header<'a>(v: &'a serde_json::Value) -> Option<&'a serde_json::Value> {
    if let Some(obj) = v.as_object() {
        if let Some(header) = obj.get("activeAccountHeaderRenderer") {
            return Some(header);
        }
        for (_, val) in obj {
            if let Some(found) = find_active_account_header(val) {
                return Some(found);
            }
        }
    } else if let Some(arr) = v.as_array() {
        for val in arr {
            if let Some(found) = find_active_account_header(val) {
                return Some(found);
            }
        }
    }
    None
}

#[tauri::command]
pub(crate) async fn get_user_profile(state: State<'_, SessionState>) -> Result<Option<UserProfile>, String> {
    let maybe_cookies = state.cookies.lock().unwrap().clone();
    if maybe_cookies.is_none() {
        return Ok(None);
    }

    let client = &*HTTP_CLIENT;
    let body = serde_json::json!({
        "context": web_remix_context()
    });

    let mut request = with_ytm_headers(client.post("https://music.youtube.com/youtubei/v1/account/account_menu"))
        .json(&body);

    request = attach_youtube_auth(request, &maybe_cookies);

    let res = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[DOT Music] Failed to send account_menu request: {}", e);
            return Ok(Some(UserProfile {
                name: "YouTube Music Account".to_string(),
                email: "Connected".to_string(),
                avatar_url: "".to_string(),
            }));
        }
    };

    let json: serde_json::Value = match res.json().await {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[DOT Music] Failed to parse account_menu JSON: {}", e);
            return Ok(Some(UserProfile {
                name: "YouTube Music Account".to_string(),
                email: "Connected".to_string(),
                avatar_url: "".to_string(),
            }));
        }
    };

    let header_opt = json
        .pointer("/actions/0/openPopupAction/popup/multiPageMenuRenderer/header/activeAccountHeaderRenderer")
        .or_else(|| json.pointer("/header/activeAccountHeaderRenderer"))
        .or_else(|| find_active_account_header(&json));

    if let Some(h) = header_opt {
        let name = h
            .pointer("/accountName/runs/0/text")
            .or_else(|| h.pointer("/accountName/simpleText"))
            .or_else(|| h.pointer("/channelHandle/runs/0/text"))
            .or_else(|| h.pointer("/channelHandle/simpleText"))
            .or_else(|| h.pointer("/title/runs/0/text"))
            .and_then(|v| v.as_str())
            .unwrap_or("YouTube User")
            .to_string();

        let email = h
            .pointer("/email/runs/0/text")
            .or_else(|| h.pointer("/email/simpleText"))
            .or_else(|| h.pointer("/channelHandle/runs/0/text"))
            .or_else(|| h.pointer("/channelHandle/simpleText"))
            .or_else(|| h.pointer("/subtitle/runs/0/text"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let raw_avatar = h
            .pointer("/accountPhoto/thumbnails")
            .or_else(|| h.pointer("/thumbnail/thumbnails"))
            .or_else(|| h.pointer("/avatar/thumbnails"))
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

    Ok(Some(UserProfile {
        name: "YouTube Music Account".to_string(),
        email: "Connected".to_string(),
        avatar_url: "".to_string(),
    }))
}
