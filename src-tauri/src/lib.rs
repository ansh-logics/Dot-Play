mod feed;
mod fsutil;
mod haptics;
mod import;
mod immersive;
mod library;
mod lyrics;
mod media_controls;
mod models;
mod playback;
mod player_server;
mod playlist;
mod queue_session;
mod recommendations;
mod remote;
mod search;
mod session;
mod shortcuts;
mod thumbnails;
mod tray;
mod updater;
mod ytmusic;

use player_server::{start_player_server, PlayerServerState};
use session::SessionState;
#[cfg(not(debug_assertions))]
use tauri::{ipc::CapabilityBuilder, Manager, Url};

/// Mirrors capabilities/default.json (a test keeps them in sync).
#[cfg_attr(debug_assertions, allow(dead_code))]
const MAIN_WINDOW_PERMISSIONS: &[&str] = &[
    "core:default",
    "core:event:default",
    "core:window:allow-is-fullscreen",
    "core:window:allow-set-fullscreen",
    "core:window:allow-minimize",
    "allow-search-tracks",
    "allow-open-login-window",
    "allow-get-auth-status",
    "allow-logout",
    "allow-get-home-feed",
    "allow-get-home-feed-continuation",
    "allow-get-playlist-details",
    "allow-get-playlist-continuation",
    "allow-get-highres-thumbnails",
    "allow-get-user-profile",
    "allow-get-history",
    "allow-get-library-playlists",
    "allow-record-playback",
    "allow-save-queue-session",
    "allow-get-queue-session",
    "allow-get-related-recommendations",
    "allow-get-player-server-url",
    "allow-get-lyrics",
    "allow-perform-haptic",
    "allow-set-now-playing",
    "allow-get-now-playing",
    "allow-tray-media-control",
    "allow-get-like-status",
    "allow-rate-song",
    "allow-get-playlists-for-song",
    "allow-set-song-in-playlist",
    "allow-create-playlist",
    "allow-show-main-window",
    "allow-hide-tray-popover",
    "allow-get-pending-update",
    "allow-install-update",
    "allow-open-immersive",
    "allow-close-immersive",
    "allow-set-immersive-idle",
    "allow-list-immersive-displays",
    "allow-set-immersive-screens",
    "allow-set-immersive-display",
    "allow-leave-immersive-to-player",
    "allow-fetch-external-playlist",
    "allow-match-track",
    "allow-list-local-playlists",
    "allow-get-local-playlist",
    "allow-save-local-playlist",
    "allow-delete-local-playlist",
    "allow-get-remote-status",
    "allow-set-remote-enabled",
    "allow-answer-pair-request",
    "allow-forget-remote-device",
    "allow-set-remote-state",
];

/// Mirrors capabilities/aux-windows.json (a test keeps them in sync).
#[cfg_attr(debug_assertions, allow(dead_code))]
const AUX_WINDOW_PERMISSIONS: &[&str] = &[
    "core:default",
    "core:event:default",
    "allow-get-now-playing",
    "allow-tray-media-control",
    "allow-show-main-window",
    "allow-hide-tray-popover",
    "allow-open-immersive",
    "allow-close-immersive",
    "allow-set-immersive-idle",
    "allow-list-immersive-displays",
    "allow-set-immersive-screens",
    "allow-set-immersive-display",
    "allow-leave-immersive-to-player",
];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let player_port = start_player_server();
    let local_app_port = if cfg!(debug_assertions) {
        None
    } else {
        Some(portpicker::pick_unused_port().expect("Failed to find an available localhost port"))
    };

    let builder = tauri::Builder::default()
        .manage(SessionState::default())
        .manage(PlayerServerState(player_port))
        .manage(media_controls::LastNowPlaying::default())
        .manage(updater::PendingUpdate::default())
        .manage(remote::RemoteHub::default())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build());

    let builder = if let Some(port) = local_app_port {
        builder.plugin(
            tauri_plugin_localhost::Builder::new(port)
                .host("localhost")
                .on_request(|_, response| {
                    response.add_header("Referrer-Policy", "strict-origin-when-cross-origin");
                })
                .build(),
        )
    } else {
        builder
    };

    builder
        .setup(move |app| {
            media_controls::init(app.handle());

            #[cfg(debug_assertions)]
            let tray_url: Option<tauri::Url> = None;
            #[cfg(not(debug_assertions))]
            let mut tray_url: Option<tauri::Url> = None;

            #[cfg(not(debug_assertions))]
            if let Some(port) = local_app_port {
                let app_url: Url = format!("http://localhost:{port}")
                    .parse()
                    .map_err(|error| format!("Invalid local app URL: {error}"))?;

                // Same split as capabilities/*.json, which only cover the dev server: the main
                // window gets every command, the popover and immersive screens only what they use.
                let mut main_window = CapabilityBuilder::new("localhost-main")
                    .remote(app_url.to_string())
                    .local(false)
                    .window("main");
                for permission in MAIN_WINDOW_PERMISSIONS {
                    main_window = main_window.permission(*permission);
                }
                app.add_capability(main_window)?;

                let mut aux_windows = CapabilityBuilder::new("localhost-aux-windows")
                    .remote(app_url.to_string())
                    .local(false)
                    .window(tray::POPOVER_LABEL)
                    .window("immersive-*");
                for permission in AUX_WINDOW_PERMISSIONS {
                    aux_windows = aux_windows.permission(*permission);
                }
                app.add_capability(aux_windows)?;
                tray_url = Some(app_url.clone());

                app.get_webview_window("main")
                    .ok_or("Main window was not available")?
                    .navigate(app_url)?;
            }

            immersive::init(app.handle(), tray_url.clone());
            tray::init(app.handle(), tray_url)?;
            shortcuts::init(app.handle());
            updater::init(app.handle());

            session::restore_saved_state(app);
            remote::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search::search_tracks,
            session::open_login_window,
            session::get_auth_status,
            session::logout,
            feed::get_home_feed,
            feed::get_home_feed_continuation,
            playlist::get_playlist_details,
            playlist::get_playlist_continuation,
            thumbnails::get_highres_thumbnails,
            session::get_user_profile,
            feed::get_history,
            feed::get_library_playlists,
            playback::record_playback,
            queue_session::save_queue_session,
            queue_session::get_queue_session,
            recommendations::get_related_recommendations,
            player_server::get_player_server_url,
            lyrics::get_lyrics,
            haptics::perform_haptic,
            media_controls::set_now_playing,
            media_controls::get_now_playing,
            media_controls::tray_media_control,
            library::get_like_status,
            library::rate_song,
            library::get_playlists_for_song,
            library::set_song_in_playlist,
            library::create_playlist,
            tray::show_main_window,
            tray::hide_tray_popover,
            updater::get_pending_update,
            updater::install_update,
            immersive::open_immersive,
            immersive::close_immersive,
            immersive::set_immersive_idle,
            immersive::list_immersive_displays,
            immersive::set_immersive_screens,
            immersive::set_immersive_display,
            immersive::leave_immersive_to_player,
            import::fetch_external_playlist,
            import::match_track,
            import::list_local_playlists,
            import::get_local_playlist,
            import::save_local_playlist,
            import::delete_local_playlist,
            remote::get_remote_status,
            remote::set_remote_enabled,
            remote::answer_pair_request,
            remote::forget_remote_device,
            remote::set_remote_state
        ])
        // Closing the main window keeps the music playing; the menu bar icon controls it.
        // Quit from the tray menu or with Cmd+Q.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                tray::prepare_exit(app);
            }
            // Clicking the Dock icon brings the hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::{AUX_WINDOW_PERMISSIONS, MAIN_WINDOW_PERMISSIONS};

    fn permissions_in(file: &str) -> Vec<String> {
        let path = format!("{}/capabilities/{file}", env!("CARGO_MANIFEST_DIR"));
        let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        json["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn release_capabilities_match_the_dev_files() {
        assert_eq!(permissions_in("default.json"), MAIN_WINDOW_PERMISSIONS);
        assert_eq!(permissions_in("aux-windows.json"), AUX_WINDOW_PERMISSIONS);
        assert!(!MAIN_WINDOW_PERMISSIONS.contains(&"allow-save-session"));
    }
}
