fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&[
        "search_tracks",
        "open_login_window",
        "save_session",
        "get_auth_status",
        "logout",
        "get_home_feed",
        "get_home_feed_continuation",
        "get_playlist_details",
        "get_highres_thumbnails",
        "get_user_profile",
        "get_history",
        "get_library_playlists",
        "record_playback",
        "save_queue_session",
        "get_queue_session",
        "get_related_recommendation",
        "get_player_server_url",
      ]),
    ),
  )
  .expect("failed to build Tauri application");
}
