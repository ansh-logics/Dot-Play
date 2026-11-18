//! Where the scrobbling sign-ins are kept: the macOS Keychain in release builds, a private
//! (owner-only) file otherwise. Development builds use the file too: every rebuild is signed
//! differently, and the Keychain would ask for the password after each one.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct Credentials {
    pub lastfm: Option<Account>,
    pub listenbrainz: Option<Account>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Account {
    pub username: String,
    /// Last.fm session key, or ListenBrainz user token.
    pub secret: String,
}

static CACHE: Mutex<Option<Credentials>> = Mutex::new(None);

#[cfg(all(target_os = "macos", not(debug_assertions)))]
mod store {
    const SERVICE: &str = "com.anshbhatt.dotmusic.connections";
    const ACCOUNT: &str = "scrobbling";

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
    }

    pub(super) fn load(_app: &tauri::AppHandle) -> Option<String> {
        entry().ok()?.get_password().ok()
    }

    pub(super) fn save(_app: &tauri::AppHandle, data: Option<&str>) -> Result<(), String> {
        let entry = entry()?;
        match data {
            Some(json) => entry.set_password(json).map_err(|e| e.to_string()),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            },
        }
    }
}

#[cfg(not(all(target_os = "macos", not(debug_assertions))))]
mod store {
    use tauri::Manager;

    fn path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
        Some(app.path().app_data_dir().ok()?.join("connections.json"))
    }

    pub(super) fn load(app: &tauri::AppHandle) -> Option<String> {
        std::fs::read_to_string(path(app)?).ok()
    }

    pub(super) fn save(app: &tauri::AppHandle, data: Option<&str>) -> Result<(), String> {
        let path = path(app).ok_or("no app data folder")?;
        match data {
            // Owner-only: these are sign-ins.
            Some(json) => crate::fsutil::write_atomic(&path, json.as_bytes(), true).map_err(|e| e.to_string()),
            None => match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            },
        }
    }
}

/// The saved sign-ins (read once, then from memory).
pub(crate) fn load(app: &AppHandle) -> Credentials {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(found) = cache.as_ref() {
        return found.clone();
    }
    let found = store::load(app).and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
    *cache = Some(found);
    cache.clone().unwrap_or_default()
}

/// Changes the saved sign-ins with `edit` and stores the result.
pub(crate) fn update(app: &AppHandle, edit: impl FnOnce(&mut Credentials)) -> Result<Credentials, String> {
    let mut current = load(app);
    edit(&mut current);
    let empty = current.lastfm.is_none() && current.listenbrainz.is_none();
    let json = serde_json::to_string(&current).map_err(|e| e.to_string())?;
    store::save(app, if empty { None } else { Some(&json) })?;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(current.clone());
    Ok(current)
}

/// The app data folder exists and is ours (used by the queue file next to it).
pub(crate) fn data_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok()
}
