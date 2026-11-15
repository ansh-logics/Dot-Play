//! The TV app (Android TV): a receiver with a ten-foot interface.
//!
//! It shares the YouTube Music layer with the desktop app but has no sign-in window of its
//! own (a TV remote is no way to type a Google password). Instead it listens on the local
//! network (`link::host`), shows a code, and a desktop app that links with that code hands
//! over its session. No tray, immersive screens, updater or Phone Remote host here.

use crate::link::host::{Host, HostEvent};
use crate::link::{self, LinkRecord, Peer};
use crate::player_server::{start_player_server, PlayerServerState};
use crate::session::SessionState;
use crate::{feed, library, lyrics, playback, player_server, playlist, queue_session, recommendations, search, session, thumbnails};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

/// The links this TV holds, in the private `tv_link.json`.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default)]
    id: String,
    #[serde(default)]
    links: Vec<LinkRecord>,
}

struct TvLink(Arc<Host>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkState {
    name: String,
    /// The pairing code to show while a desktop links.
    code: String,
    /// Desktops this TV is linked to.
    linked: Vec<Peer>,
    /// Which of them are connected right now.
    online: Vec<String>,
    signed_in: bool,
}

fn saved_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("tv_link.json"))
}

fn load(app: &AppHandle) -> Saved {
    saved_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn persist(app: &AppHandle, host: &Host) {
    let Some(path) = saved_path(app) else { return };
    let saved = Saved { id: host.me().id.clone(), links: host.links() };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Owner-only: the link secrets let a desktop hand this TV a session.
    if let Ok(json) = serde_json::to_vec(&saved) {
        if let Err(error) = crate::fsutil::write_atomic(&path, &json, true) {
            log::warn!("Saving the TV's links failed: {error}");
        }
    }
}

/// The name people gave this TV (the Android side passes it in), or its model.
fn device_name() -> String {
    std::env::var("DOTPLAY_DEVICE_NAME")
        .ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "TV".to_string())
}

fn link_state(app: &AppHandle, host: &Host) -> LinkState {
    let signed_in = app.state::<SessionState>().cookies.lock().unwrap().is_some();
    LinkState {
        name: host.me().name.clone(),
        code: host.code(),
        linked: host.links().into_iter().map(|l| Peer { id: l.id, name: l.name }).collect(),
        online: host.online(),
        signed_in,
    }
}

#[tauri::command]
fn tv_link_state(app: AppHandle, link: State<'_, TvLink>) -> LinkState {
    link_state(&app, &link.0)
}

/// "Sign out" on the TV: forgets every desktop and the session they handed over.
#[tauri::command]
fn tv_sign_out(app: AppHandle, link: State<'_, TvLink>) -> LinkState {
    for desktop in link.0.links() {
        link.0.remove_link(&desktop.id);
    }
    persist(&app, &link.0);
    session::adopt_session(&app, None);
    link_state(&app, &link.0)
}

fn start_link(app: &AppHandle) {
    let saved = load(app);
    // The Android side advertises this id on the network, so it decides it when it can.
    let id = std::env::var("DOTPLAY_DEVICE_ID")
        .ok()
        .filter(|id| !id.is_empty())
        .or_else(|| Some(saved.id.clone()).filter(|id| !id.is_empty()))
        .unwrap_or_else(link::random_id);
    let (events, mut inbox) = mpsc::unbounded_channel();
    let host = Host::new(Peer { id, name: device_name() }, saved.links, events);
    persist(app, &host);
    app.manage(TvLink(host.clone()));

    let serving = host.clone();
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::bind(("0.0.0.0", link::PORT)).await {
            Ok(listener) => serving.serve(listener).await,
            Err(error) => log::error!("The TV can't listen for the desktop app on port {}: {error}", link::PORT),
        }
    });

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = inbox.recv().await {
            match event {
                HostEvent::Linked { cookies, .. } => {
                    persist(&app, &host);
                    // A desktop that isn't signed in links without changing who is.
                    if cookies.is_some() {
                        session::adopt_session(&app, cookies);
                    }
                }
                HostEvent::Session { cookies } => session::adopt_session(&app, cookies),
                HostEvent::Unlinked { .. } => {
                    persist(&app, &host);
                    // The last desktop leaving takes the session with it.
                    if host.links().is_empty() {
                        session::adopt_session(&app, None);
                    }
                }
                HostEvent::Message { message, .. } => {
                    let _ = app.emit("tv-command", message);
                }
                HostEvent::Online { .. } | HostEvent::CodeChanged => {}
            }
            let _ = app.emit("tv-link-changed", ());
        }
    });
}

pub fn run() {
    let player_port = start_player_server();

    tauri::Builder::default()
        .manage(SessionState::default())
        .manage(PlayerServerState(player_port))
        // Info and up: trace logging (every JNI call) costs real CPU on a TV chip.
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .setup(|app| {
            session::restore_saved_state(app);
            start_link(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tv_link_state,
            tv_sign_out,
            search::search_tracks,
            session::get_auth_status,
            session::logout,
            session::get_user_profile,
            feed::get_home_feed,
            feed::get_home_feed_continuation,
            feed::get_history,
            feed::get_library_playlists,
            playlist::get_playlist_details,
            playlist::get_playlist_continuation,
            thumbnails::get_highres_thumbnails,
            playback::record_playback,
            queue_session::save_queue_session,
            queue_session::get_queue_session,
            recommendations::get_related_recommendations,
            player_server::get_player_server_url,
            lyrics::get_lyrics,
            library::get_like_status,
            library::rate_song,
            library::get_playlists_for_song,
            library::set_song_in_playlist,
            library::create_playlist,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the TV app");
}
