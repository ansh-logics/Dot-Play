//! Crash-safe file writes for the app's saved state.

use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Writes `data` to a temporary file next to `path`, then renames it over `path`, so a
/// crash or full disk mid-write never leaves a half-written file behind. With `private`,
/// the file is readable by the current user only (used for the sign-in session).
pub(crate) fn write_atomic(path: &Path, data: &[u8], private: bool) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // A unique temp name per write, so two writers never share (and interleave) one file.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(format!(".{}.{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let tmp = Path::new(&tmp_name);

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;

    let result = options.open(tmp).and_then(|mut file| {
        file.write_all(data)?;
        file.sync_all()
    });
    let result = result.and_then(|()| std::fs::rename(tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}
