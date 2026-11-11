//! The TV app (Android TV): a receiver with a ten-foot interface.
//!
//! It shares the YouTube Music layer with the desktop app but has no sign-in window of its
//! own (a TV remote is no way to type a Google password); the desktop app links it and
//! hands over the session. No tray, immersive screens, updater or Phone Remote host here.

use crate::player_server::{start_player_server, PlayerServerState};
use crate::session::SessionState;
use crate::{feed, library, lyrics, playback, player_server, playlist, queue_session, recommendations, search, session, thumbnails};

pub fn run() {
    let player_port = start_player_server();

    tauri::Builder::default()
        .manage(SessionState::default())
        .manage(PlayerServerState(player_port))
        // Info and up: trace logging (every JNI call) costs real CPU on a TV chip.
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .setup(|app| {
            session::restore_saved_state(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
