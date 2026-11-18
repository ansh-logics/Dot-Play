import { useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useScrobbleStatus } from "../../lib/scrobble";

/** Settings → Scrobbling: sign in to Last.fm and ListenBrainz. */
export function ScrobbleSettings() {
  const status = useScrobbleStatus();
  if (!status) return null;
  return (
    <div className="settings-section">
      <span className="settings-section-title">SCROBBLING</span>
      <LastFmRow available={status.lastfmAvailable} user={status.lastfmUser} />
      <ListenBrainzRow user={status.listenbrainzUser} />
      {status.pending > 0 && (
        <p className="settings-note">
          {status.pending === 1 ? "1 listen is" : `${status.pending} listens are`} waiting to be sent. DOT Music keeps trying.
        </p>
      )}
    </div>
  );
}

const RULE = "Songs count once you've heard half of them, or 4 minutes.";

function LastFmRow({ available, user }: { available: boolean; user: string | null }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!available) {
    return (
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-label">Last.fm</span>
          <span className="settings-desc">Not available in this build.</span>
        </div>
      </div>
    );
  }

  const connect = async () => {
    setError(null);
    setWaiting(true);
    try {
      await invoke<string>("lastfm_connect");
    } catch (e) {
      if (String(e) !== "cancelled") setError(String(e));
    } finally {
      setWaiting(false);
    }
  };

  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-label">Last.fm</span>
        <span className="settings-desc">
          {error
            ? error
            : user
              ? `Scrobbling as ${user}. ${RULE}`
              : waiting
                ? "Approve DOT Music on last.fm in your browser, then come back."
                : `Send what you listen to to your Last.fm profile. ${RULE}`}
        </span>
      </div>
      {user ? (
        <button type="button" className="settings-action-btn" onClick={() => void invoke("lastfm_disconnect")}>
          Disconnect
        </button>
      ) : waiting ? (
        <button type="button" className="settings-action-btn" onClick={() => void invoke("lastfm_cancel_connect")}>
          Cancel
        </button>
      ) : (
        <button type="button" className="settings-action-btn" onClick={() => void connect()}>
          Connect
        </button>
      )}
    </div>
  );
}

function ListenBrainzRow({ user }: { user: string | null }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await invoke<string>("listenbrainz_connect", { token });
      setToken("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (user) {
    return (
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-label">ListenBrainz</span>
          <span className="settings-desc">Sending listens as {user}.</span>
        </div>
        <button type="button" className="settings-action-btn" onClick={() => void invoke("listenbrainz_disconnect")}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <form className="settings-row settings-row--stack" onSubmit={(e) => void connect(e)}>
      <div className="settings-row-text">
        <span className="settings-label">ListenBrainz</span>
        <span className="settings-desc">
          {error ?? "Paste your user token from listenbrainz.org → Settings."}
        </span>
      </div>
      <div className="settings-inline-form">
        <input
          className="new-playlist-input settings-token-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="User token"
          aria-label="ListenBrainz user token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="settings-action-btn" disabled={busy || !token.trim()}>
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
    </form>
  );
}
