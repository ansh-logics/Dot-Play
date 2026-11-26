import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { useDialogFocus } from "../../lib/a11y";
import { fetchLyricsCandidates, type TrackLyrics } from "../../lib/lyrics";
import { clearPin, getPin, setPin } from "../../lib/lyricsPrefs";
import "./LyricsPicker.css";

interface LyricsPickerProps {
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  /** Length in seconds, so candidates timed for another version are shown as plain. */
  duration?: number;
  currentSource?: string;
  onClose: () => void;
}

function syncLabel(syncType: TrackLyrics["syncType"]): string {
  switch (syncType) {
    case "word":
      return "Word";
    case "line":
      return "Line";
    case "plain":
      return "Plain";
    default:
      return "Plain";
  }
}

/** The first two non-empty lines, as the listener will recognise the right lyrics by. */
function preview(candidate: TrackLyrics): string {
  return candidate.lines
    .map((line) => line.text.trim())
    .filter((text) => text.length > 0)
    .slice(0, 2)
    .join("\n");
}

/**
 * "Wrong lyrics?": every provider's answer for the current song, plus Automatic. Choosing one
 * pins this song to that provider; the lyrics panel reloads from the prefs notification.
 */
export function LyricsPicker({ videoId, title, artist, album, duration, currentSource, onClose }: LyricsPickerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const pinned = getPin(videoId);
  const [candidates, setCandidates] = useState<TrackLyrics[] | null>(null);
  const [failed, setFailed] = useState(false);
  useDialogFocus(dialogRef);

  useEffect(() => {
    firstOptionRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchLyricsCandidates(title, artist, duration, videoId, album)
      .then((answers) => {
        if (!cancelled) setCandidates(answers);
      })
      .catch((err: unknown) => {
        console.warn("[DOT Music] Failed to load lyrics candidates:", err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [title, artist, duration, videoId, album]);

  // Esc is handled by Now Playing (innermost first), which also keeps it from the app.

  const choose = (provider?: string) => {
    if (provider) setPin(videoId, provider);
    else clearPin(videoId);
    onClose();
  };

  const automatic = !pinned;
  const loading = candidates === null && !failed;
  const otherCandidates = candidates ?? [];

  return (
    <div className="np-lyrics-picker-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="np-lyrics-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Choose lyrics"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="np-lyrics-picker-header">
          <div>
            <h3 className="np-lyrics-picker-title">Wrong lyrics?</h3>
            <p className="np-lyrics-picker-subtitle">Pick the version that matches this song.</p>
          </div>
          <button
            type="button"
            className="np-lyrics-picker-close"
            onClick={onClose}
            aria-label="Close"
            data-dialog-close
          >
            <X size={17} />
          </button>
        </div>

        <div className="np-lyrics-picker-body" role="radiogroup" aria-label="Lyrics source">
          <button
            ref={firstOptionRef}
            type="button"
            role="radio"
            aria-checked={automatic}
            className={`np-lyrics-picker-option ${automatic ? "is-current" : ""}`}
            onClick={() => choose()}
          >
            <span className="np-lyrics-picker-main">
              <span className="np-lyrics-picker-name">Automatic (best match)</span>
              <span className="np-lyrics-picker-preview">
                {currentSource && currentSource !== "unavailable"
                  ? `Now: ${currentSource}`
                  : "Tries your sources in order"}
              </span>
            </span>
            {automatic && <Check className="np-lyrics-picker-check" size={16} />}
          </button>

          {loading && (
            <div className="np-lyrics-picker-status" aria-live="polite">
              <span className="np-lyrics-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Finding other lyrics…
            </div>
          )}

          {failed && <div className="np-lyrics-picker-status">Couldn't check other lyrics.</div>}

          {!loading && !failed && otherCandidates.length === 0 && (
            <div className="np-lyrics-picker-status">No other lyrics found</div>
          )}

          {otherCandidates.map((candidate, index) => {
            const selected = pinned === candidate.source;
            const text = preview(candidate);
            return (
              <button
                key={`${candidate.source}-${index}`}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`np-lyrics-picker-option ${selected ? "is-current" : ""}`}
                onClick={() => choose(candidate.source)}
              >
                <span className="np-lyrics-picker-main">
                  <span className="np-lyrics-picker-name-row">
                    <span className="np-lyrics-picker-name">{candidate.source}</span>
                    <span className="np-lyrics-picker-badge">{syncLabel(candidate.syncType)}</span>
                  </span>
                  <span className="np-lyrics-picker-preview">{text || "No preview"}</span>
                </span>
                {selected && <Check className="np-lyrics-picker-check" size={16} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
