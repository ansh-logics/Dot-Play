//! On-device romanization and translation of lyric lines (macOS), through the Swift bridge in
//! swift/LyricAlternates.swift. Nothing is sent anywhere: romanization is Foundation's ICU
//! transliteration and translation is Apple's Translation framework with downloaded models.
//! Elsewhere both commands answer "unavailable" and the lyrics toggles stay hidden.
// The cache helpers are only reached on macOS.
#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Manager};

/// More lines than any song has; bounds the work a single call can ask for.
const MAX_LINES: usize = 600;
const MAX_LINE_CHARS: usize = 500;
const CACHE_MAX_FILES: usize = 500;

fn clean(lines: Vec<String>) -> Vec<String> {
    lines
        .into_iter()
        .take(MAX_LINES)
        .map(|line| line.chars().take(MAX_LINE_CHARS).collect())
        .collect()
}

#[cfg(target_os = "macos")]
mod bridge {
    use serde_json::Value;
    use std::ffi::{c_char, CStr, CString};

    unsafe extern "C" {
        fn dot_romanize(input: *const c_char) -> *mut c_char;
        fn dot_translate(input: *const c_char) -> *mut c_char;
        fn dot_alternates_free(pointer: *mut c_char);
    }

    fn call(f: unsafe extern "C" fn(*const c_char) -> *mut c_char, request: &Value) -> Option<Value> {
        let input = CString::new(request.to_string()).ok()?;
        // SAFETY: the Swift side reads the NUL-terminated input, returns a strdup'd string (or
        // null) and expects it back in dot_alternates_free.
        unsafe {
            let out = f(input.as_ptr());
            if out.is_null() {
                return None;
            }
            let text = CStr::from_ptr(out).to_string_lossy().into_owned();
            dot_alternates_free(out);
            serde_json::from_str(&text).ok()
        }
    }

    pub fn romanize(request: &Value) -> Option<Value> {
        call(dot_romanize, request)
    }

    pub fn translate(request: &Value) -> Option<Value> {
        call(dot_translate, request)
    }
}

/// Each line in Latin letters, or null where a line was Latin already. Null overall when the
/// platform can't romanize or no line changed (nothing worth a toggle).
#[tauri::command]
pub async fn romanize_lyrics(lines: Vec<String>) -> Result<Option<Vec<Option<String>>>, String> {
    let lines = clean(lines);
    #[cfg(target_os = "macos")]
    {
        let reply = tauri::async_runtime::spawn_blocking(move || bridge::romanize(&json!({ "lines": lines })))
            .await
            .map_err(|e| e.to_string())?;
        let out: Option<Vec<Option<String>>> = reply.and_then(|v| serde_json::from_value(v["lines"].clone()).ok());
        Ok(out.filter(|lines| lines.iter().any(Option::is_some)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = lines;
        Ok(None)
    }
}

fn cache_path(app: &AppHandle, lines: &[String], target: &str) -> Option<std::path::PathBuf> {
    let mut hash = Sha1::new();
    // Bumped when the translator changes, so older translations are made again.
    hash.update(b"v3\n");
    hash.update(target.as_bytes());
    for line in lines {
        hash.update(b"\n");
        hash.update(line.as_bytes());
    }
    let dir = app.path().app_cache_dir().ok()?.join("lyric_translations");
    Some(dir.join(format!("{:x}.json", hash.finalize())))
}

/// Keeps the folder bounded by dropping the oldest files.
fn prune(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= CACHE_MAX_FILES {
        return;
    }
    files.sort();
    for (_, path) in files.iter().take(files.len() - CACHE_MAX_FILES) {
        let _ = std::fs::remove_file(path);
    }
}

/// Translates the lines into `target` (the system language when not given). The reply's
/// `status` is "translated" (with `lines`), "sameLanguage", "unknownLanguage", "notInstalled"
/// (the language pair needs downloading in System Settings), "unsupported", "unavailable"
/// (older macOS, or not a Mac) or "error". Translations are cached by lines and language.
#[tauri::command]
pub async fn translate_lyrics(app: AppHandle, lines: Vec<String>, target: Option<String>) -> Result<Value, String> {
    let lines = clean(lines);
    #[cfg(target_os = "macos")]
    {
        let target = target.filter(|t| !t.trim().is_empty() && t.len() < 40);
        let cache = cache_path(&app, &lines, target.as_deref().unwrap_or("system"));
        if let Some(cached) = cache.as_ref().and_then(|p| std::fs::read_to_string(p).ok()) {
            if let Ok(value) = serde_json::from_str::<Value>(&cached) {
                return Ok(value);
            }
        }
        let request = json!({ "lines": lines, "target": target });
        let reply = tauri::async_runtime::spawn_blocking(move || bridge::translate(&request))
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| json!({ "status": "error", "message": "No reply from the translator" }));
        if reply["status"] == "translated" {
            if let Some(path) = cache {
                if let Some(dir) = path.parent() {
                    let _ = std::fs::create_dir_all(dir);
                    let _ = crate::fsutil::write_atomic(&path, reply.to_string().as_bytes(), false);
                    prune(dir);
                }
            }
        }
        Ok(reply)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, lines, target);
        Ok(json!({ "status": "unavailable" }))
    }
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn caps_line_count_and_length() {
        let lines = vec!["x".repeat(800); 700];
        let out = clean(lines);
        assert_eq!(out.len(), 600);
        assert_eq!(out[0].chars().count(), 500);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn romanizes_on_device() {
        let reply = super::bridge::romanize(&serde_json::json!({ "lines": ["(दिल, ये दिल)", "Привет", "Hello", "Café"] })).unwrap();
        assert_eq!(reply["lines"], serde_json::json!(["(dil, ye dil)", "Privet", null, null]));
    }
}
