import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { Download } from "lucide-react"
import { LiquidGlassSurface } from "./ui/LiquidGlassSurface"

interface UpdateInfo {
  version: string
  currentVersion: string
  notes: string | null
}

interface UpdateProgress {
  downloaded: number
  total: number | null
}

/**
 * Announces a new release found by the Rust updater (src-tauri/src/updater.rs) and installs it
 * on request. "Later" hides it until the next check finds the update again.
 */
export function UpdatePrompt() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // The announcement may have fired before this window loaded.
    invoke<UpdateInfo | null>("get_pending_update")
      .then((info) => info && setUpdate(info))
      .catch(() => {})
    const unlistenAvailable = listen<UpdateInfo>("update-available", (event) => {
      setUpdate(event.payload)
      setDismissed(null)
    })
    const unlistenProgress = listen<UpdateProgress>("update-progress", (event) => setProgress(event.payload))
    return () => {
      void unlistenAvailable.then((stop) => stop())
      void unlistenProgress.then((stop) => stop())
    }
  }, [])

  if (!update || dismissed === update.version) return null

  const installing = progress !== null && !error
  const percent =
    progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null

  const install = () => {
    setError(null)
    setProgress({ downloaded: 0, total: null })
    // On success the app restarts into the new version, so only failures come back.
    invoke("install_update").catch((reason) => {
      setError(typeof reason === "string" ? reason : "The update couldn't be installed.")
      setProgress(null)
    })
  }

  return (
    <div className="update-prompt" role="status" aria-live="polite">
      <LiquidGlassSurface as="div" variant="toast" radius={14} className="update-prompt-card">
        <div className="update-prompt-row">
          <span className="dot-red-accent small" />
          <div className="update-prompt-copy">
            <span className="update-prompt-title">dot(.)music {update.version} is available</span>
            <span className="update-prompt-sub">
              {error
                ? error
                : installing
                  ? percent === null
                    ? "Downloading…"
                    : percent < 100
                      ? `Downloading… ${percent}%`
                      : "Installing…"
                  : `You have ${update.currentVersion}.`}
            </span>
          </div>
        </div>
        {installing ? (
          <div className="update-prompt-bar" aria-hidden="true">
            <span style={{ width: `${percent ?? 8}%` }} />
          </div>
        ) : (
          <div className="update-prompt-actions">
            <button type="button" className="update-prompt-later" onClick={() => setDismissed(update.version)}>
              Later
            </button>
            <button type="button" className="update-prompt-install" onClick={install}>
              <Download size={13} />
              {error ? "Try again" : "Restart to update"}
            </button>
          </div>
        )}
      </LiquidGlassSurface>
    </div>
  )
}
