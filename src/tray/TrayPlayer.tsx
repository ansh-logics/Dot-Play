import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import {
  ArrowUpRight,
  ListMusic,
  MessageSquareQuote,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useArtworkPalette } from "../lib/useArtworkPalette";
import { QueueView } from "./QueueView";
import { usePosition } from "./usePosition";
import { command, formatTime, media, type NowPlaying, type TrayState } from "./types";

// Lyrics parsing is the heaviest code here; only load it when the view is opened.
const LyricsView = lazy(() => import("./LyricsView"));

type Panel = "none" | "lyrics" | "queue";

/** While dragging, volume changes are sent at most this often. */
const VOLUME_THROTTLE_MS = 100;

const openApp = () => void invoke("show_main_window").catch(() => {});

/** The menu bar mini player: a phone-style remote for the main window's player. */
export function TrayPlayer() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [state, setState] = useState<TrayState | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [scrub, setScrub] = useState<number | null>(null);
  const position = usePosition(np);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const keep = (fn: () => void) => (disposed ? fn() : unlisteners.push(fn));

    void invoke<NowPlaying | null>("get_now_playing").then((value) => {
      if (!disposed) setNp(value);
    });
    void Promise.all([
      listen<NowPlaying | null>("now-playing", ({ payload }) => setNp(payload)).then(keep),
      listen<TrayState>("tray-state", ({ payload }) => setState(payload)).then(keep),
    ]).then(() => {
      // Ask the main window for the queue/modes now that we're listening.
      if (!disposed) void emitTo("main", "tray-ready").catch(() => {});
    });
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const panelRef = useRef(panel);
  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);

  const hasTrack = np !== null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (panelRef.current !== "none") setPanel("none");
        else void invoke("hide_tray_popover").catch(() => {});
        return;
      }
      const tag = (event.target as HTMLElement).tagName;
      if (!hasTrack || tag === "INPUT") return;
      if (event.key === " ") {
        if (tag === "BUTTON") return; // Space already clicks the focused button
        event.preventDefault();
        media({ action: "toggle" });
      } else if (event.key === "ArrowRight") media({ action: "next" });
      else if (event.key === "ArrowLeft") media({ action: "previous" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasTrack]);

  const palette = useArtworkPalette(np?.artworkUrl ?? undefined);

  if (!np) {
    return (
      <main className="tray tray--empty">
        <span className="tray-empty-mark">(•)</span>
        <p className="tray-empty-title">Nothing playing</p>
        <button type="button" className="tray-link" onClick={openApp}>
          Open dot(.)music <ArrowUpRight size={13} />
        </button>
      </main>
    );
  }

  const shown = scrub ?? position;
  const duration = np.duration > 0 ? np.duration : 0;
  const togglePanel = (next: Panel) => setPanel((current) => (current === next ? "none" : next));
  const artStyle = palette && palette.zoom > 1 ? { transform: `scale(${palette.zoom})` } : undefined;

  return (
    <main
      className={`tray${panel !== "none" ? " tray--panel" : ""}`}
      style={palette ? ({ "--tray-tint": palette.colors[0] } as CSSProperties) : undefined}
    >
      {panel === "none" ? (
        <section className="tray-hero">
          <div className={`tray-cover${np.isPlaying ? "" : " is-paused"}`}>
            {np.artworkUrl && <img src={np.artworkUrl} alt="" referrerPolicy="no-referrer" style={artStyle} />}
          </div>
          <div className="tray-meta">
            <p className="tray-title" title={np.title}>{np.title}</p>
            <p className="tray-artist" title={np.artist}>{np.artist}</p>
          </div>
        </section>
      ) : (
        <>
          <section className="tray-compact">
            <div className="tray-compact-art">
              {np.artworkUrl && <img src={np.artworkUrl} alt="" referrerPolicy="no-referrer" style={artStyle} />}
            </div>
            <div className="tray-meta">
              <p className="tray-title" title={np.title}>{np.title}</p>
              <p className="tray-artist" title={np.artist}>{np.artist}</p>
            </div>
          </section>
          <section className="tray-panel-wrap">
            {panel === "queue" ? (
              <QueueView upcoming={state?.upcoming ?? []} autoplay={state?.autoplay ?? false} />
            ) : (
              <Suspense fallback={<div className="tray-panel" />}>
                <LyricsView np={np} position={position} />
              </Suspense>
            )}
          </section>
        </>
      )}

      <div className="tray-progress">
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(shown, duration || 1)}
          disabled={!duration}
          aria-label="Seek"
          style={{ "--fill": `${duration ? (shown / duration) * 100 : 0}%` } as CSSProperties}
          onChange={(event) => setScrub(Number(event.currentTarget.value))}
          onPointerUp={(event) => {
            media({ action: "seek", position: Number(event.currentTarget.value) });
            setScrub(null);
          }}
          onKeyUp={() => {
            if (scrub === null) return;
            media({ action: "seek", position: scrub });
            setScrub(null);
          }}
        />
        <div className="tray-times">
          <span>{formatTime(shown)}</span>
          <span>-{formatTime(Math.max(0, duration - shown))}</span>
        </div>
      </div>

      <div className="tray-controls">
        <button
          type="button"
          className={`tray-mode${state?.shuffle ? " is-on" : ""}`}
          aria-label="Shuffle"
          aria-pressed={state?.shuffle ?? false}
          onClick={() => command({ type: "toggleShuffle" })}
        >
          <Shuffle size={16} />
        </button>
        <button type="button" aria-label="Previous" onClick={() => media({ action: "previous" })}>
          <SkipBack size={22} fill="currentColor" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="tray-play"
          aria-label={np.isPlaying ? "Pause" : "Play"}
          onClick={() => media({ action: "toggle" })}
        >
          {np.isPlaying ? (
            <Pause size={22} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={22} fill="currentColor" strokeWidth={0} style={{ marginLeft: 3 }} />
          )}
        </button>
        <button type="button" aria-label="Next" onClick={() => media({ action: "next" })}>
          <SkipForward size={22} fill="currentColor" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className={`tray-mode${state && state.repeat !== "off" ? " is-on" : ""}`}
          aria-label={`Repeat: ${state?.repeat ?? "off"}`}
          onClick={() => command({ type: "cycleRepeat" })}
        >
          {state?.repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}
        </button>
      </div>

      <VolumeRow volume={state?.volume ?? 100} muted={state?.muted ?? false} />

      <nav className="tray-bar">
        <button
          type="button"
          className={panel === "lyrics" ? "is-on" : undefined}
          aria-label="Lyrics"
          aria-pressed={panel === "lyrics"}
          onClick={() => togglePanel("lyrics")}
        >
          <MessageSquareQuote size={17} />
        </button>
        <button type="button" className="tray-link" onClick={openApp}>
          Open dot(.)music <ArrowUpRight size={13} />
        </button>
        <button
          type="button"
          className={panel === "queue" ? "is-on" : undefined}
          aria-label="Up Next"
          aria-pressed={panel === "queue"}
          onClick={() => togglePanel("queue")}
        >
          <ListMusic size={17} />
        </button>
      </nav>
    </main>
  );
}

function VolumeRow({ volume, muted }: { volume: number; muted: boolean }) {
  // Local value while dragging, so the slider doesn't wait on the round trip.
  const [drag, setDrag] = useState<number | null>(null);
  const lastSent = useRef(0);
  const shown = drag ?? (muted ? 0 : volume);
  const Icon = muted || shown === 0 ? VolumeX : shown < 50 ? Volume1 : Volume2;

  const send = (value: number, force = false) => {
    const now = performance.now();
    if (!force && now - lastSent.current < VOLUME_THROTTLE_MS) return;
    lastSent.current = now;
    command({ type: "setVolume", volume: value });
  };

  return (
    <div className="tray-volume">
      <button type="button" aria-label={muted ? "Unmute" : "Mute"} onClick={() => command({ type: "toggleMute" })}>
        <Icon size={15} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={shown}
        aria-label="Volume"
        style={{ "--fill": `${shown}%` } as CSSProperties}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          setDrag(value);
          send(value);
        }}
        onPointerUp={(event) => {
          send(Number(event.currentTarget.value), true);
          setDrag(null);
        }}
        onKeyUp={(event) => {
          send(Number(event.currentTarget.value), true);
          setDrag(null);
        }}
      />
    </div>
  );
}
