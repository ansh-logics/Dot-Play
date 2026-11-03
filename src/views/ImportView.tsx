import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useReducedMotion } from "motion/react";
import { ArrowRight, Check, ChevronLeft, ListMusic, X } from "lucide-react";
import { OrbitMerge, type OrbitResult, type OrbitSong } from "../components/import/OrbitMerge";
import {
  buildLocalPlaylist,
  matchAll,
  readExternalPlaylist,
  saveLocalPlaylist,
  SOURCE_NAMES,
  type ExternalPlaylist,
  type LocalPlaylist,
  type TrackMatch,
} from "../lib/imports";

interface ImportViewProps {
  onClose: () => void;
  onOpenPlaylist: (id: string) => void;
  /** A playlist was saved; the Library should show it. */
  onImported: (playlist: LocalPlaylist) => void;
  /** Esc and Back are held off while songs are merging. */
  onBusyChange: (busy: boolean) => void;
}

type Stage =
  | { kind: "paste"; error?: string }
  | { kind: "reading" }
  | { kind: "merging"; playlist: ExternalPlaylist }
  | { kind: "done"; saved: LocalPlaylist };

const SOURCES = ["Spotify", "Apple Music", "Deezer", "YouTube Music", "Song list"];

function looksLikeLink(text: string): boolean {
  return /^(https?:\/\/|spotify:)\S+$/.test(text.trim());
}

/** A note when the source shares only part of the playlist. */
function partialNote(playlist: ExternalPlaylist): string | null {
  if (playlist.total && playlist.total > playlist.tracks.length) {
    return `${SOURCE_NAMES[playlist.source]} shares the first ${playlist.tracks.length} of ${playlist.total} songs.`;
  }
  if (playlist.source === "spotify" && playlist.tracks.length >= 100) {
    return "Spotify only shares the first 100 songs of a playlist.";
  }
  return null;
}

/**
 * Bring a playlist in from anywhere. Paste a link (or a list of songs), watch every song
 * orbit the dot and merge into it as it's found on YouTube Music, and the playlist is kept
 * on this Mac.
 */
export function ImportView({ onClose, onOpenPlaylist, onImported, onBusyChange }: ImportViewProps) {
  const reduceMotion = useReducedMotion();
  const [stage, setStage] = useState<Stage>({ kind: "paste" });
  const [input, setInput] = useState("");
  const [results, setResults] = useState<OrbitResult[]>([]);
  const [merged, setMerged] = useState(0);
  const savedRef = useRef<LocalPlaylist | null>(null);
  const settledRef = useRef(false);
  const signalRef = useRef({ cancelled: false });

  const busy = stage.kind === "reading" || stage.kind === "merging";
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(
    () => () => {
      signalRef.current.cancelled = true;
      onBusyChange(false);
    },
    [onBusyChange],
  );

  const finishIfReady = useCallback(() => {
    if (settledRef.current && savedRef.current) setStage({ kind: "done", saved: savedRef.current });
  }, []);

  const start = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value) return;
      const signal = { cancelled: false };
      signalRef.current = signal;
      savedRef.current = null;
      settledRef.current = false;
      setMerged(0);
      setStage({ kind: "reading" });

      let playlist: ExternalPlaylist;
      let known: TrackMatch[] | undefined;
      try {
        const read = await readExternalPlaylist(value);
        playlist = read.playlist;
        known = read.matches;
      } catch (err) {
        if (!signal.cancelled) setStage({ kind: "paste", error: String(err) });
        return;
      }
      if (signal.cancelled) return;
      if (playlist.tracks.length === 0) {
        setStage({ kind: "paste", error: "That playlist has no songs." });
        return;
      }

      const orbitResult = (m: TrackMatch | null): OrbitResult => (m ? m.thumbnailUrl : null);
      setResults(known ? known.map(orbitResult) : new Array(playlist.tracks.length).fill(undefined));
      setStage({ kind: "merging", playlist });

      const matches = known ?? (await matchAll(
        playlist.tracks,
        (index, match) =>
          setResults((prev) => {
            const next = prev.slice();
            next[index] = orbitResult(match);
            return next;
          }),
        signal,
      ));
      if (signal.cancelled) return;

      try {
        const saved = await saveLocalPlaylist(buildLocalPlaylist(playlist, matches));
        if (signal.cancelled) return;
        savedRef.current = saved;
        onImported(saved);
        finishIfReady();
      } catch (err) {
        if (!signal.cancelled) setStage({ kind: "paste", error: `Couldn't save the playlist. ${String(err)}` });
      }
    },
    [finishIfReady, onImported],
  );

  const cancel = () => {
    signalRef.current.cancelled = true;
    setStage({ kind: "paste" });
  };

  const onSettled = useCallback(() => {
    settledRef.current = true;
    finishIfReady();
  }, [finishIfReady]);
  const onMerged = useCallback(() => setMerged((n) => n + 1), []);

  const playlist = stage.kind === "merging" ? stage.playlist : null;
  const songs = useMemo<OrbitSong[]>(
    () => playlist?.tracks.map((t) => ({ title: t.title, artist: t.artist, cover: t.coverUrl })) ?? [],
    [playlist],
  );

  // Without motion there is no orbit to wait for: done as soon as every song is checked.
  const checked = results.filter((r) => r !== undefined).length;
  const missing = results.filter((r) => r === null).length;
  useEffect(() => {
    if (reduceMotion && playlist && checked === songs.length) onSettled();
  }, [reduceMotion, playlist, checked, songs.length, onSettled]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void start(input);
    }
  };

  return (
    <div className="import-view">
      <header className="import-topbar">
        <button
          type="button"
          className="album-glass-btn is-small"
          onClick={busy ? cancel : onClose}
          aria-label={busy ? "Cancel import" : "Back"}
          title={busy ? "Cancel import" : "Back"}
        >
          {busy ? <X size={15} /> : <ChevronLeft size={16} />}
        </button>
      </header>

      {stage.kind === "paste" && (
        <section className="import-paste">
          <div className="import-paste-mark" aria-hidden="true">
            <span className="orbit-core-dot" />
          </div>
          <h1 className="import-title">Import a playlist</h1>
          <p className="import-subtitle">
            Paste a link from anywhere. Every song is found on YouTube Music and the playlist is kept on this Mac.
          </p>
          <div className="import-sources" aria-label="Works with">
            {SOURCES.map((s) => (
              <span key={s} className="import-source-chip">
                {s}
              </span>
            ))}
          </div>
          <form
            className={`import-field ${input.includes("\n") ? "is-list" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              void start(input);
            }}
          >
            <textarea
              autoFocus
              rows={input.includes("\n") ? 6 : 1}
              value={input}
              placeholder="open.spotify.com/playlist/…  or one song per line"
              aria-label="Playlist link or song list"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text");
                if (looksLikeLink(text) && !input.trim()) {
                  e.preventDefault();
                  setInput(text.trim());
                  void start(text);
                }
              }}
            />
            <button type="submit" className="import-go" disabled={!input.trim()} aria-label="Import">
              <ArrowRight size={18} />
            </button>
          </form>
          {stage.error ? (
            <p className="import-error" role="alert">
              {stage.error}
            </p>
          ) : (
            <p className="import-hint">For a song list, write “Artist - Title” on each line (Shift+Enter for a new line).</p>
          )}
        </section>
      )}

      {stage.kind === "reading" && (
        <section className="import-reading" aria-live="polite">
          <div className="import-paste-mark is-breathing" aria-hidden="true">
            <span className="orbit-core-dot" />
          </div>
          <p className="import-subtitle">Reading the playlist…</p>
        </section>
      )}

      {playlist && (
        <section className="import-merging">
          <div className="import-source-head">
            {playlist.coverUrl ? (
              <img className="import-source-cover" src={playlist.coverUrl} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span className="import-source-cover is-empty">
                <ListMusic size={20} />
              </span>
            )}
            <div className="import-source-text">
              <span className="import-source-from">From {SOURCE_NAMES[playlist.source]}</span>
              <span className="import-source-title">{playlist.title}</span>
              <span className="import-source-meta">
                {[playlist.owner, `${playlist.tracks.length} songs`].filter(Boolean).join(" · ")}
              </span>
            </div>
          </div>

          {reduceMotion ? (
            <ol className="import-calm-list">
              {playlist.tracks.map((t, i) => (
                <li key={i} className={results[i] === null ? "is-missing" : results[i] !== undefined ? "is-found" : ""}>
                  <span className="import-calm-mark">{results[i] === undefined ? "·" : results[i] === null ? "–" : <Check size={12} />}</span>
                  <span className="import-calm-title">{t.title}</span>
                  <span className="import-calm-artist">{t.artist}</span>
                </li>
              ))}
            </ol>
          ) : (
            <OrbitMerge songs={songs} results={results} onSettled={onSettled} onMerged={onMerged} />
          )}

          <p className="import-counter" aria-live="polite">
            <strong>{reduceMotion ? checked - missing : merged}</strong> / {songs.length} merged
            {missing > 0 && <span className="import-counter-missing"> · {missing} not found</span>}
          </p>
          {partialNote(playlist) && <p className="import-hint">{partialNote(playlist)}</p>}
        </section>
      )}

      {stage.kind === "done" && (
        <section className="import-done">
          <img
            className="import-done-cover"
            src={stage.saved.cover || stage.saved.tracks.find((t) => t.match)?.match?.thumbnailUrl || ""}
            alt=""
          />
          <span className="import-source-from">Imported from {SOURCE_NAMES[stage.saved.source]}</span>
          <h1 className="import-title">{stage.saved.title}</h1>
          <p className="import-subtitle">
            {(() => {
              const found = stage.saved.tracks.filter((t) => t.match).length;
              const all = stage.saved.tracks.length;
              return found === all ? `All ${all} songs found.` : `${found} of ${all} songs found.`;
            })()}
          </p>
          <div className="import-done-actions">
            <button type="button" className="new-playlist-btn is-primary" onClick={() => onOpenPlaylist(stage.saved.id)}>
              Open Playlist
            </button>
            <button
              type="button"
              className="new-playlist-btn"
              onClick={() => {
                setInput("");
                setStage({ kind: "paste" });
              }}
            >
              Import Another
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
