import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Clock, Image, MessageSquareQuote, Monitor, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { MiniVinyl } from "../components/vinyl/MiniVinyl";
import { activeRowIndex, type LyricRow } from "../components/now-playing/lyricRows";
import { closeImmersive, leaveToPlayer, setDisplayOn, type ImmersiveView } from "../lib/immersive";
import type { PlayerSkinId } from "../lib/playerSkins";
import { useArtworkPalette } from "../lib/useArtworkPalette";
import { usePosition } from "../tray/usePosition";
import { formatTime, media, type NowPlaying } from "../tray/types";
import { Cover } from "./Cover";
import { CassetteArt, CassetteStage } from "./CassetteSaver";
import {
  SCREEN,
  clockParts,
  useDisplays,
  useImmersiveData,
  useLyricRows,
  useNow,
  useScreenView,
  type DisplaysState,
  type LyricsResult,
} from "./hooks";

const NO_ROWS: LyricRow[] = [];

/** The controls and the pointer hide after this long without the mouse moving. */
const CONTROLS_HIDE_MS = 2600;

const VIEWS: Array<{ id: ImmersiveView; label: string; Icon: typeof Clock }> = [
  { id: "stage", label: "Clock", Icon: Clock },
  { id: "lyrics", label: "Lyrics", Icon: MessageSquareQuote },
  { id: "art", label: "Artwork", Icon: Image },
];

/**
 * One display in immersive mode: the clock with the song (the stage), the lyrics, or the
 * artwork. Each display picks its own view; the look follows the player style.
 */
export function Immersive() {
  const { np, state } = useImmersiveData();
  const [view, setView] = useScreenView();
  const skin: PlayerSkinId = state?.skin ?? "apple";
  const position = usePosition(np);
  const now = useNow();
  const controls = useControlsReveal();
  const displays = useDisplays();
  const displayCount = displays.count;

  // The stage shows the current line itself when there's no other display for lyrics.
  const inlineLyric = view === "stage" && displayCount === 1;
  const lyrics = useLyricRows(np, view === "lyrics" || inlineLyric);

  const art = np?.artworkUrl ?? null;
  const palette = useArtworkPalette(art ?? undefined);
  const zoom = palette?.zoom ?? 1;

  const displaysRef = useRef(displays);
  useEffect(() => {
    displaysRef.current = displays;
  }, [displays]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") leaveToPlayer();
      else if (/^[1-9]$/.test(event.key)) {
        // Number keys match the display chips: show or hide on that display.
        const { displays: list, off, count } = displaysRef.current;
        const index = Number(event.key) - 1;
        const display = list[index];
        if (!display) return;
        const on = !off.has(display.key);
        if (on && count <= 1) return; // the last display stays on
        setDisplayOn(display.key, index, !on);
      } else if (event.key === " ") {
        event.preventDefault();
        media({ action: "toggle" });
      } else if (event.key === "ArrowRight") media({ action: "next" });
      else if (event.key === "ArrowLeft") media({ action: "previous" });
      else if (event.key.toLowerCase() === "v") {
        const at = VIEWS.findIndex((v) => v.id === view);
        setView(VIEWS[(at + 1) % VIEWS.length].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, setView]);

  const tint = palette
    ? ({ "--im-a": palette.colors[0], "--im-b": palette.colors[1], "--im-c": palette.colors[2], "--im-base": palette.base } as CSSProperties)
    : undefined;
  // Without lyrics to show, the lyrics display falls back to the artwork.
  const shown: ImmersiveView = !np ? "stage" : view === "lyrics" && lyrics.status === "none" ? "art" : view;

  return (
    <div className={`im-root${controls.visible ? "" : " is-idle"}`} data-skin={skin} data-view={shown} style={tint}>
      <Backdrop art={art} skin={skin} />
      <div className="im-content">
        {shown === "stage" &&
          (skin === "cassette" ? (
            <CassetteStage np={np} now={now} position={position} next={state?.next ?? null} lyrics={inlineLyric ? lyrics : null} />
          ) : (
            <Stage np={np} now={now} position={position} skin={skin} art={art} zoom={zoom} next={state?.next ?? null} lyrics={inlineLyric ? lyrics : null} />
          ))}
        {shown === "lyrics" && np && <LyricsScreen np={np} now={now} position={position} lyrics={lyrics} art={art} zoom={zoom} />}
        {shown === "art" &&
          np &&
          (skin === "cassette" ? (
            <CassetteArt np={np} now={now} position={position} />
          ) : (
            <ArtScreen np={np} now={now} position={position} skin={skin} art={art} zoom={zoom} />
          ))}
      </div>
      <Controls np={np} view={view} onView={setView} displays={displays} />
    </div>
  );
}

/** Shows the controls and the pointer while the mouse moves. */
function useControlsReveal() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let timer = 0;
    // The first event is often the window appearing under a still pointer.
    let last: { x: number; y: number } | null = null;
    const onMove = (event: MouseEvent) => {
      const moved = last && Math.hypot(event.clientX - last.x, event.clientY - last.y) > 3;
      last = { x: event.clientX, y: event.clientY };
      if (!moved) return;
      setVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setVisible(false), CONTROLS_HIDE_MS);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.clearTimeout(timer);
    };
  }, []);
  return { visible };
}

function Backdrop({ art, skin }: { art: string | null; skin: PlayerSkinId }) {
  return (
    <div className="im-backdrop" aria-hidden="true">
      {art && skin !== "nothing" && skin !== "cassette" && <img className="im-backdrop-art" src={art} alt="" referrerPolicy="no-referrer" />}
      <div className="im-backdrop-tint" />
      <div className="im-backdrop-vignette" />
    </div>
  );
}

function BigClock({ now, skin }: { now: Date; skin: PlayerSkinId }) {
  const { hour, minute } = clockParts(now);
  return (
    <p className="im-clock" data-skin={skin}>
      <span>{hour}</span>
      <span className="im-clock-colon">:</span>
      <span>{minute}</span>
    </p>
  );
}

/** The small clock in a corner of the lyrics and artwork displays. */
function CornerClock({ now }: { now: Date }) {
  const { hour, minute, date } = clockParts(now);
  return (
    <div className="im-corner-clock">
      <span className="im-corner-time">
        {hour}:{minute}
      </span>
      <span className="im-corner-date">{date}</span>
    </div>
  );
}

interface ArtworkProps {
  art: string | null;
  zoom: number;
  skin: PlayerSkinId;
  playing: boolean;
  className: string;
}

function Artwork({ art, zoom, skin, playing, className }: ArtworkProps) {
  const img = <Cover url={art} zoom={zoom} />;
  if (skin === "vinyl") {
    return (
      <div className={`${className} is-vinyl`}>
        <MiniVinyl isPlaying={playing}>{img}</MiniVinyl>
      </div>
    );
  }
  return <div className={`${className}${playing ? "" : " is-paused"}`}>{img}</div>;
}

function Progress({ np, position }: { np: NowPlaying; position: number }) {
  const duration = np.duration > 0 ? np.duration : 0;
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
  return (
    <div className="im-progress">
      <div className="im-progress-track">
        <div className="im-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="im-progress-times">
        <span>{formatTime(position)}</span>
        <span>{np.isPlaying ? `-${formatTime(Math.max(0, duration - position))}` : "Paused"}</span>
      </div>
    </div>
  );
}

interface StageProps {
  np: NowPlaying | null;
  now: Date;
  position: number;
  skin: PlayerSkinId;
  art: string | null;
  zoom: number;
  next: { title: string; artist: string } | null;
  lyrics: LyricsResult | null;
}

/** The clock, big, with the song underneath, like the lock screen. */
function Stage({ np, now, position, skin, art, zoom, next, lyrics }: StageProps) {
  const { date } = clockParts(now);
  return (
    <section className="im-stage">
      <div className="im-stage-top">
        <p className="im-date">{date}</p>
        <BigClock now={now} skin={skin} />
        {lyrics?.status === "synced" && <CurrentLine rows={lyrics.rows} position={position} />}
      </div>
      {np ? (
        <div className="im-np">
          <Artwork art={art} zoom={zoom} skin={skin} playing={np.isPlaying} className="im-np-art" />
          <div className="im-np-text">
            <p className="im-np-title">{np.title}</p>
            <p className="im-np-artist">{np.artist}</p>
            <Progress np={np} position={position} />
            {next && (
              <p className="im-np-next">
                <span>Up next</span> {next.title}
                {next.artist && ` · ${next.artist}`}
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="im-np-empty">Nothing playing</p>
      )}
    </section>
  );
}

/** The line being sung, under the clock; crossfades as the song moves on. */
function CurrentLine({ rows, position }: { rows: LyricRow[]; position: number }) {
  const active = activeRowIndex(rows, position);
  const row = rows[active];
  const text = row?.kind === "line" ? row.line.text : "";
  return (
    <p key={row?.key ?? "none"} className="im-current-line">
      {text || " "}
    </p>
  );
}

interface ScreenProps {
  np: NowPlaying;
  now: Date;
  position: number;
  art: string | null;
  zoom: number;
}

/** Big synced lyrics, the line being sung held in the middle. */
function LyricsScreen({ np, now, position, lyrics, art, zoom }: ScreenProps & { lyrics: LyricsResult }) {
  const rows = lyrics.status === "synced" ? lyrics.rows : NO_ROWS;
  const active = activeRowIndex(rows, position);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-row="${Math.max(0, active)}"]`);
    if (!list || !el) return;
    const box = list.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    list.scrollTo({ top: list.scrollTop + row.top - box.top - (box.height - row.height) * 0.42, behavior: "smooth" });
  }, [active, rows]);

  return (
    <section className="im-lyrics-screen">
      <CornerClock now={now} />
      <div className="im-lyrics" ref={listRef}>
        <div className="im-lyrics-pad" />
        {rows.map((row, index) => {
          const state = index === active ? " is-active" : index < active ? " is-past" : "";
          return row.kind === "interlude" ? (
            <p key={row.key} data-row={index} className={`im-lyric im-lyric--dots${state}`}>
              •••
            </p>
          ) : (
            <p key={row.key} data-row={index} className={`im-lyric${state}`}>
              {row.line.text}
            </p>
          );
        })}
        <div className="im-lyrics-pad" />
      </div>
      <div className="im-mini-np">
        <div className="im-mini-art">
          <Cover url={art} zoom={zoom} />
        </div>
        <div>
          <p className="im-mini-title">{np.title}</p>
          <p className="im-mini-artist">{np.artist}</p>
        </div>
      </div>
    </section>
  );
}

/** The artwork as the centrepiece: a record for Vinyl, dot-matrix for Nothing. */
function ArtScreen({ np, now, position, skin, art, zoom }: ScreenProps & { skin: PlayerSkinId }) {
  return (
    <section className="im-art-screen">
      <CornerClock now={now} />
      <Artwork art={art} zoom={zoom} skin={skin} playing={np.isPlaying} className="im-hero-art" />
      <div className="im-art-meta">
        <p className="im-np-title">{np.title}</p>
        <p className="im-np-artist">{np.artist}</p>
        <Progress np={np} position={position} />
      </div>
    </section>
  );
}

interface ControlsProps {
  np: NowPlaying | null;
  view: ImmersiveView;
  onView: (view: ImmersiveView) => void;
  displays: DisplaysState;
}

function Controls({ np, view, onView, displays }: ControlsProps) {
  return (
    <div className="im-controls" role="toolbar" aria-label="Immersive controls">
      {np && (
        <>
          <button type="button" aria-label="Previous" onClick={() => media({ action: "previous" })}>
            <SkipBack size={20} fill="currentColor" strokeWidth={1.5} />
          </button>
          <button type="button" className="im-play" aria-label={np.isPlaying ? "Pause" : "Play"} onClick={() => media({ action: "toggle" })}>
            {np.isPlaying ? <Pause size={22} fill="currentColor" strokeWidth={0} /> : <Play size={22} fill="currentColor" strokeWidth={0} style={{ marginLeft: 3 }} />}
          </button>
          <button type="button" aria-label="Next" onClick={() => media({ action: "next" })}>
            <SkipForward size={20} fill="currentColor" strokeWidth={1.5} />
          </button>
          <span className="im-controls-divider" />
        </>
      )}
      <div className="im-views" role="radiogroup" aria-label="This display shows">
        {VIEWS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={view === id}
            className={view === id ? "is-on" : undefined}
            title={`${label} (V)`}
            onClick={() => onView(id)}
          >
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <span className="im-controls-divider" />
      {displays.displays.length > 1 && (
        <>
          <DisplayChips state={displays} />
          <span className="im-controls-divider" />
        </>
      )}
      <button type="button" aria-label="Leave immersive mode" title="Leave (Esc goes back to the player)" onClick={closeImmersive}>
        <X size={20} />
      </button>
    </div>
  );
}

/**
 * One chip per connected display, numbered in order: lit where immersive mode shows, dim
 * where it doesn't. Click to turn a display on or off; the chip with the dot under it is the
 * display you're looking at.
 */
function DisplayChips({ state }: { state: DisplaysState }) {
  const { displays, off, count } = state;
  return (
    <div className="im-displays-chips" role="group" aria-label="Show on displays">
      <Monitor size={16} className="im-displays-icon" aria-hidden="true" />
      {displays.map((display, index) => {
        const on = !off.has(display.key);
        const here = display.key === SCREEN.screenKey;
        // The last display showing it stays on; ✕ leaves instead.
        const locked = on && count <= 1;
        return (
          <button
            key={display.key}
            type="button"
            aria-pressed={on}
            aria-label={`${display.name}${here ? " (this display)" : ""}`}
            className={`im-display-chip${on ? " is-on" : ""}${here ? " is-here" : ""}`}
            disabled={locked}
            title={`${display.name} · ${display.pixelWidth}×${display.pixelHeight}${here ? " · this display" : ""}\n${
              locked ? "The last display stays on (✕ leaves)" : on ? "Click to stop showing here" : "Click to show here"
            }`}
            onClick={() => setDisplayOn(display.key, index, !on)}
          >
            {index + 1}
          </button>
        );
      })}
    </div>
  );
}
