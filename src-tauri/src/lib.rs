mod feed;
mod fsutil;
mod haptics;
mod lyrics;
mod media_controls;
mod models;
mod playback;
mod player_server;
mod playlist;
mod queue_session;
mod recommendations;
mod search;
mod session;
mod thumbnails;
mod tray;
mod updater;
mod ytmusic;

use player_server::{start_player_server, PlayerServerState};
use session::SessionState;
#[cfg(not(debug_assertions))]
use tauri::{ipc::CapabilityBuilder, Manager, Url};

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

                app.add_capability(
                    CapabilityBuilder::new("localhost-app")
                        .remote(app_url.to_string())
                        .local(false)
                        .window("main")
                        .window(tray::POPOVER_LABEL)
                        .permission("core:default")
                        .permission("core:event:default")
                        .permission("allow-search-tracks")
                        .permission("allow-open-login-window")
                        .permission("allow-save-session")
                        .permission("allow-get-auth-status")
                        .permission("allow-logout")
                        .permission("allow-get-home-feed")
                        .permission("allow-get-home-feed-continuation")
                        .permission("allow-get-playlist-details")
                        .permission("allow-get-highres-thumbnails")
                        .permission("allow-get-user-profile")
                        .permission("allow-get-history")
                        .permission("allow-get-library-playlists")
                        .permission("allow-record-playback")
                        .permission("allow-save-queue-session")
                        .permission("allow-get-queue-session")
                        .permission("allow-get-related-recommendations")
                        .permission("allow-get-player-server-url")
                        .permission("allow-get-lyrics")
                        .permission("allow-perform-haptic")
                        .permission("allow-set-now-playing")
                        .permission("allow-get-now-playing")
                        .permission("allow-tray-media-control")
                        .permission("allow-show-main-window")
                        .permission("allow-hide-tray-popover")
                        .permission("allow-get-pending-update")
                        .permission("allow-install-update"),
                )?;
                tray_url = Some(app_url.clone());

                app.get_webview_window("main")
                    .ok_or("Main window was not available")?
                    .navigate(app_url)?;
            }

            tray::init(app.handle(), tray_url)?;
            updater::init(app.handle());

            session::restore_saved_state(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search::search_tracks,
            session::open_login_window,
            session::save_session,
            session::get_auth_status,
            session::logout,
            feed::get_home_feed,
            feed::get_home_feed_continuation,
            playlist::get_playlist_details,
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
            tray::show_main_window,
            tray::hide_tray_popover,
            updater::get_pending_update,
            updater::install_update
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
