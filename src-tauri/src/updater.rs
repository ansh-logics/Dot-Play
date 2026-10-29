//! Automatic updates from GitHub Releases.
//!
//! Release builds check `latest.json` on the latest GitHub release shortly after launch and
//! then every few hours. A newer, correctly signed version is announced to the main window
//! (`update-available`); the user picks "Restart to update" and `install_update` downloads it,
//! swaps the app bundle and relaunches. The signature is checked against the public key in
//! `tauri.conf.json` before anything is installed.
//!
//! The check runs here rather than from JavaScript so the localhost-served frontend needs no
//! updater permissions, only the two commands below.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Let launch-time work (session restore, the first home feed) settle before checking.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(8);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const AVAILABLE_EVENT: &str = "update-available";
const PROGRESS_EVENT: &str = "update-progress";

/// The update found by the last check, kept until it is installed.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

impl From<&Update> for UpdateInfo {
    fn from(update: &Update) -> Self {
        Self {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
        }
    }
}

/// Starts the background checks. Debug builds skip them: their version is the one being
/// developed, and a dev run should never replace itself with a release.
pub fn init(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            if let Err(error) = check(&app).await {
                log::warn!("update check failed: {error}");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let info = UpdateInfo::from(&update);
    *app.state::<PendingUpdate>().0.lock().unwrap() = Some(update);
    let _ = app.emit_to("main", AVAILABLE_EVENT, info);
    Ok(())
}

/// The update found so far, for a window that loaded after the announcement.
#[tauri::command]
pub fn get_pending_update(state: tauri::State<'_, PendingUpdate>) -> Option<UpdateInfo> {
    state.0.lock().unwrap().as_ref().map(UpdateInfo::from)
}

/// Downloads and installs the pending update, then relaunches into it.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("No update is pending")?;

    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit_to(
                    "main",
                    PROGRESS_EVENT,
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;

    // restart() skips the run loop's exit events, so put the menu bar panel back first.
    crate::tray::prepare_exit(&app);
    app.restart();
}
