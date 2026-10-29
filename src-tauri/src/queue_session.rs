//! Saving and restoring the play queue between launches.

use crate::models::SearchResult;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
pub(crate) async fn save_queue_session(app: AppHandle, session: QueueSession) -> Result<bool, String> {
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
pub(crate) async fn get_queue_session(app: AppHandle) -> Result<Option<QueueSession>, String> {
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
