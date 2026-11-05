import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Reorder, useDragControls } from "motion/react";
import {
  CornerDownRight,
  GripVertical,
  Heart,
  ListMusic,
  ListPlus,
  Mic2,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { formatTime } from "../lib/formatTime";
import { cleanArtistName, cleanTrackTitle, processLyricsPayload, type TrackLyrics } from "../lib/lyrics";
import { useArtworkPalette } from "../lib/useArtworkPalette";
import type { TrayQueueItem } from "../lib/useTrayBridge";
import { activeRowIndex, buildLyricRows } from "../components/now-playing/lyricRows";
import {
  usePosition,
  useRemoteState,
  type LyricsQuery,
  type MediaAction,
  type RemoteNowPlaying,
  type RemoteQueueState,
  type SearchHit,
} from "./useRemoteState";
import type { LyricsPayload } from "../lib/lyrics";
import type { TrayCommand } from "../lib/useTrayBridge";

type Tab = "playing" | "lyrics" | "queue" | "search";
type Send = (command: TrayCommand | MediaAction) => void;
type RequestLyrics = (q: LyricsQuery) => Promise<LyricsPayload | null>;
type RequestSearch = (query: string) => Promise<SearchHit[] | null>;

/** Wait this long after the last keystroke before asking the Mac. */
const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_MIN_CHARS = 2;

/** Volume changes are sent at most this often while dragging. */
const VOLUME_THROTTLE_MS = 80;

export function RemoteApp() {
  const { connection, np, state, send, requestLyrics, requestSearch, computer } = useRemoteState();
  const [tab, setTab] = useState<Tab>("playing");
  // Kept here so the search survives switching tabs.
  const [query, setQuery] = useState("");
  const palette = useArtworkPalette(np?.artworkUrl ?? undefined);

  const tint = palette
    ? ({
        "--c1": palette.colors[0],
        "--c2": palette.colors[1],
        "--c3": palette.colors[2],
        "--base": palette.base,
      } as CSSProperties)
    : undefined;

  // Reopening: the last track and queue show at once while the connection comes back.
  if (connection.kind === "checking" && !np) return <Splash text="Connecting…" />;
  if (connection.kind === "waiting") {
    return <Splash text={`Waiting for your ${computer}`} sub={`Click Allow in dot(.)music on your ${computer}.`} breathing />;
  }
  if (connection.kind === "macOffline") {
    return (
      <Splash
        text={`Your ${computer} is offline`}
        sub={`Open dot(.)music on your ${computer} and make sure it's connected to the internet. This page reconnects by itself.`}
        breathing
      />
    );
  }
  if (connection.kind === "unpaired") {
    return (
      <Splash
        text={`Pair with your ${computer}`}
        sub={connection.message ?? `In dot(.)music on your ${computer}, open Settings → Phone Remote and scan the QR code.`}
      />
    );
  }

  return (
    <div className="rm-root" style={tint}>
      <div className="rm-backdrop" aria-hidden="true">
        {np?.artworkUrl && <img src={np.artworkUrl} alt="" referrerPolicy="no-referrer" />}
      </div>

      <header className="rm-top">
        <span className="rm-brand">
          <span className="rm-brand-dot" /> dot(.)music
        </span>
        {(connection.kind === "reconnecting" || connection.kind === "checking") && (
          <span className="rm-pill">{connection.kind === "checking" ? "Connecting…" : "Reconnecting…"}</span>
        )}
      </header>

      <main className="rm-main">
        {tab === "search" ? (
          <SearchTab query={query} onQueryChange={setQuery} requestSearch={requestSearch} send={send} computer={computer} />
        ) : !np ? (
          <div className="rm-empty">
            <Music2 size={28} />
            <p>Nothing playing on your {computer}.</p>
          </div>
        ) : tab === "playing" ? (
          // A new song starts fresh: no half-finished drag carried over from the last one.
          <PlayingTab key={np.videoId ?? np.title} np={np} state={state} send={send} />
        ) : tab === "lyrics" ? (
          <LyricsTab np={np} send={send} requestLyrics={requestLyrics} />
        ) : (
          <QueueTab state={state} send={send} />
        )}
      </main>

      {np && tab !== "playing" && <MiniBar np={np} send={send} onOpen={() => setTab("playing")} />}

      <nav className="rm-tabs" aria-label="Views">
        <TabButton active={tab === "playing"} onClick={() => setTab("playing")} icon={<Music2 size={20} />} label="Playing" />
        <TabButton active={tab === "lyrics"} onClick={() => setTab("lyrics")} icon={<Mic2 size={20} />} label="Lyrics" />
        <TabButton active={tab === "queue"} onClick={() => setTab("queue")} icon={<ListMusic size={20} />} label="Up Next" />
        <TabButton active={tab === "search"} onClick={() => setTab("search")} icon={<Search size={20} />} label="Search" />
      </nav>
    </div>
  );
}

/**
 * Artwork that shimmers until its image has loaded, then fades in. A new URL (song change)
 * shimmers again rather than showing the old cover or a half-drawn image.
 */
function Art({
  src,
  className,
  fallback,
  eager,
}: {
  src: string | null | undefined;
  className: string;
  fallback?: React.ReactNode;
  eager?: boolean;
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const isLoaded = Boolean(src) && loaded === src;
  const showFallback = !src || failed === src;
  return (
    <span className={`rm-art-frame ${className} ${isLoaded || showFallback ? "is-loaded" : "rm-shimmer"}`}>
      {showFallback
        ? fallback
        : src && (
            <img
              key={src}
              src={src}
              alt=""
              referrerPolicy="no-referrer"
              loading={eager ? "eager" : "lazy"}
              decoding="async"
              onLoad={() => setLoaded(src)}
              onError={() => setFailed(src)}
            />
          )}
    </span>
  );
}

function Splash({ text, sub, breathing }: { text: string; sub?: string; breathing?: boolean }) {
  return (
    <div className="rm-splash">
      <div className={`rm-mark ${breathing ? "is-breathing" : ""}`} aria-hidden="true">
        <span className="rm-brand-dot" />
      </div>
      <h1>{text}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button type="button" className={`rm-tab ${active ? "is-active" : ""}`} onClick={onClick} aria-current={active}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------
// Now Playing

function PlayingTab({ np, state, send }: { np: RemoteNowPlaying; state: RemoteQueueState | null; send: Send }) {
  const position = usePosition(np);
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? position;
  // Right after a song change the player hasn't reported the new length yet (0), or the
  // position still belongs to the old song; until both make sense, show the song as loading.
  const ready = np.duration > 0 && position <= np.duration + 2;
  const repeat = state?.repeat ?? "off";

  return (
    <section className="rm-playing">
      <Art src={np.artworkUrl} className="rm-art" eager fallback={<Music2 size={48} />} />

      <div className="rm-meta">
        <div className="rm-meta-text">
          <h1 className="rm-title">{np.title}</h1>
          <p className="rm-artist">{np.artist}</p>
        </div>
        {state?.liked != null && (
          <button
            type="button"
            className={`rm-icon-btn ${state.liked ? "is-liked" : ""}`}
            onClick={() => send({ type: "toggleLike" })}
            aria-label={state.liked ? "Remove from Liked Music" : "Like"}
          >
            <Heart size={22} fill={state.liked ? "currentColor" : "none"} />
          </button>
        )}
      </div>

      <div className={`rm-seek ${ready ? "" : "is-loading"}`}>
        {!ready ? (
          // The new song's length isn't known yet: a loading bar instead of one that jumps.
          <div className="rm-seek-loading" role="progressbar" aria-label="Loading song" />
        ) : (
        <input
          type="range"
          min={0}
          max={Math.max(np.duration, 1)}
          step={0.1}
          value={Math.min(shown, Math.max(np.duration, 1))}
          style={{ "--p": `${np.duration > 0 ? (shown / np.duration) * 100 : 0}%` } as CSSProperties}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={() => {
            if (scrub !== null) send({ action: "seek", position: scrub });
            setScrub(null);
          }}
          onKeyUp={() => {
            if (scrub !== null) send({ action: "seek", position: scrub });
            setScrub(null);
          }}
          aria-label="Seek"
        />
        )}
        <div className="rm-times">
          <span>{ready ? formatTime(shown) : "–:––"}</span>
          <span>{ready ? `-${formatTime(Math.max(0, np.duration - shown))}` : "–:––"}</span>
        </div>
      </div>

      <div className="rm-controls">
        <button
          type="button"
          className={`rm-icon-btn ${state?.shuffle ? "is-on" : ""}`}
          onClick={() => send({ type: "toggleShuffle" })}
          aria-label="Shuffle"
          aria-pressed={state?.shuffle ?? false}
        >
          <Shuffle size={20} />
        </button>
        <button type="button" className="rm-icon-btn is-big" onClick={() => send({ action: "previous" })} aria-label="Previous">
          <SkipBack size={30} fill="currentColor" />
        </button>
        <button type="button" className="rm-play" onClick={() => send({ action: "toggle" })} aria-label={np.isPlaying ? "Pause" : "Play"}>
          {np.isPlaying ? <Pause size={30} fill="currentColor" strokeWidth={0} /> : <Play size={30} fill="currentColor" strokeWidth={0} />}
        </button>
        <button type="button" className="rm-icon-btn is-big" onClick={() => send({ action: "next" })} aria-label="Next">
          <SkipForward size={30} fill="currentColor" />
        </button>
        <button
          type="button"
          className={`rm-icon-btn ${repeat !== "off" ? "is-on" : ""}`}
          onClick={() => send({ type: "cycleRepeat" })}
          aria-label={`Repeat: ${repeat}`}
        >
          {repeat === "one" ? <Repeat1 size={20} /> : <Repeat size={20} />}
        </button>
      </div>

      <VolumeRow volume={state?.volume ?? 100} muted={state?.muted ?? false} send={send} />
    </section>
  );
}

function VolumeRow({ volume, muted, send }: { volume: number; muted: boolean; send: Send }) {
  const [drag, setDrag] = useState<number | null>(null);
  const lastSent = useRef(0);
  const shown = drag ?? (muted ? 0 : volume);
  const Icon = shown === 0 ? VolumeX : shown < 50 ? Volume1 : Volume2;
  const apply = (value: number, force = false) => {
    const now = Date.now();
    if (force || now - lastSent.current >= VOLUME_THROTTLE_MS) {
      lastSent.current = now;
      send({ type: "setVolume", volume: value });
    }
  };
  return (
    <div className="rm-volume">
      <button type="button" className="rm-icon-btn" onClick={() => send({ type: "toggleMute" })} aria-label={muted ? "Unmute" : "Mute"}>
        <Icon size={18} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={shown}
        style={{ "--p": `${shown}%` } as CSSProperties}
        onChange={(e) => {
          const value = Number(e.target.value);
          setDrag(value);
          apply(value);
        }}
        onPointerUp={() => {
          if (drag !== null) apply(drag, true);
          setDrag(null);
        }}
        aria-label="Volume"
      />
    </div>
  );
}

function MiniBar({ np, send, onOpen }: { np: RemoteNowPlaying; send: Send; onOpen: () => void }) {
  return (
    <div className="rm-mini">
      <button type="button" className="rm-mini-info" onClick={onOpen}>
        <Art src={np.artworkUrl} className="rm-mini-art" />
        <span className="rm-mini-text">
          <span className="rm-mini-title">{np.title}</span>
          <span className="rm-mini-artist">{np.artist}</span>
        </span>
      </button>
      <button type="button" className="rm-icon-btn" onClick={() => send({ action: "toggle" })} aria-label={np.isPlaying ? "Pause" : "Play"}>
        {np.isPlaying ? <Pause size={22} fill="currentColor" strokeWidth={0} /> : <Play size={22} fill="currentColor" strokeWidth={0} />}
      </button>
      <button type="button" className="rm-icon-btn" onClick={() => send({ action: "next" })} aria-label="Next">
        <SkipForward size={22} fill="currentColor" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Lyrics

const lyricsCache = new Map<string, TrackLyrics | null>();

async function loadLyrics(np: RemoteNowPlaying, requestLyrics: RequestLyrics): Promise<TrackLyrics | null> {
  const key = np.videoId ?? `${np.title}::${np.artist}`;
  if (lyricsCache.has(key)) return lyricsCache.get(key) ?? null;
  const { cleanArtist, primaryArtist } = cleanArtistName(np.artist);
  const payload = await requestLyrics({
    title: cleanTrackTitle(np.title),
    artist: primaryArtist || cleanArtist,
    videoId: np.videoId ?? undefined,
    duration: np.duration > 0 ? np.duration : undefined,
  });
  const data = payload ? processLyricsPayload(payload, np.duration > 0 ? np.duration : undefined) : null;
  const usable = data && data.lines.length > 0 ? data : null;
  // Only keep hits: a timed-out request is worth asking again.
  if (usable) lyricsCache.set(key, usable);
  return usable;
}

function LyricsTab({ np, send, requestLyrics }: { np: RemoteNowPlaying; send: Send; requestLyrics: RequestLyrics }) {
  const key = np.videoId ?? `${np.title}::${np.artist}`;
  const [result, setResult] = useState<{ key: string; data: TrackLyrics | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadLyrics(np, requestLyrics)
      .then((data) => !cancelled && setResult({ key, data }))
      .catch(() => !cancelled && setResult({ key, data: null }));
    return () => {
      cancelled = true;
    };
    // Only a new song needs new lyrics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const position = usePosition(np);
  const data = result?.key === key ? result.data : undefined;
  const synced = Boolean(data && data.syncType !== "plain" && data.syncType !== "unavailable");
  const rows = useMemo(() => (synced && data ? buildLyricRows(data.lines) : []), [synced, data]);
  const active = synced ? activeRowIndex(rows, position) : -1;

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    if (!list || !el) return;
    const box = list.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    list.scrollTo({ top: list.scrollTop + row.top - box.top - box.height * 0.35 + row.height / 2, behavior: "smooth" });
  }, [active]);

  if (data === undefined) return <p className="rm-note">Finding lyrics…</p>;
  if (!data) return <p className="rm-note">No lyrics for this song.</p>;

  if (!synced) {
    // Untimed lyrics read from the top, with no fade over the first line.
    return (
      <div className="rm-lyrics is-plain">
        {data.lines.map((line) => (
          <p key={line.id} className="rm-lyric">
            {line.text}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="rm-lyrics" ref={listRef}>
      <div className="rm-lyrics-pad" />
      {rows.map((row, index) =>
        row.kind === "interlude" ? (
          <p key={row.key} data-row={index} className={`rm-lyric is-dots ${index === active ? "is-active" : ""}`}>
            •••
          </p>
        ) : (
          <button
            key={row.key}
            type="button"
            data-row={index}
            className={`rm-lyric ${index === active ? "is-active" : index < active ? "is-past" : ""}`}
            onClick={() => send({ action: "seek", position: row.start })}
          >
            {row.line.text}
            {row.line.background?.text && <span className="rm-lyric-bg">{row.line.background.text}</span>}
          </button>
        ),
      )}
      <div className="rm-lyrics-pad" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Up Next

function QueueTab({ state, send }: { state: RemoteQueueState | null; send: Send }) {
  const [items, setItems] = useState<TrayQueueItem[]>(state?.upcoming ?? []);
  const draggingRef = useRef(false);
  // Follow the Mac, except mid-drag (the Mac's copy catches up once the drop is sent).
  useEffect(() => {
    if (!draggingRef.current) setItems(state?.upcoming ?? []);
  }, [state?.upcoming]);

  if (!state) return <p className="rm-note">Loading Up Next…</p>;
  if (items.length === 0) return <p className="rm-note">Nothing queued. Autoplay picks the next songs.</p>;

  const more = (state.total ?? items.length) - items.length;
  return (
    <section className="rm-queue">
      <Reorder.Group axis="y" values={items} onReorder={setItems} className="rm-queue-list" as="ol">
        {items.map((item, index) => (
          <QueueRow
            key={item.videoId}
            item={item}
            index={index}
            onDragStart={() => (draggingRef.current = true)}
            onDrop={() => {
              draggingRef.current = false;
              const to = items.findIndex((t) => t.videoId === item.videoId);
              const from = state.upcoming.findIndex((t) => t.videoId === item.videoId);
              if (to !== from) send({ type: "moveQueueItem", videoId: item.videoId, to });
            }}
            send={send}
          />
        ))}
      </Reorder.Group>
      {more > 0 && <p className="rm-note is-small">and {more} more</p>}
    </section>
  );
}

function QueueRow({
  item,
  index,
  onDragStart,
  onDrop,
  send,
}: {
  item: TrayQueueItem;
  index: number;
  onDragStart: () => void;
  onDrop: () => void;
  send: Send;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={item}
      className="rm-queue-row"
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      onDragEnd={onDrop}
      as="li"
    >
      <span
        className="rm-grip"
        onPointerDown={(e) => {
          e.preventDefault();
          controls.start(e);
        }}
        aria-hidden="true"
      >
        <GripVertical size={18} />
      </span>
      <button type="button" className="rm-queue-main" onClick={() => send({ type: "playQueueItem", videoId: item.videoId })}>
        <Art src={item.thumb} className="rm-queue-thumb" />
        <span className="rm-queue-text">
          <span className="rm-queue-title">{item.title}</span>
          <span className="rm-queue-artist">{item.artist}</span>
        </span>
      </button>
      {index > 0 && (
        <button
          type="button"
          className="rm-icon-btn is-small"
          onClick={() => send({ type: "moveQueueItem", videoId: item.videoId, to: 0 })}
          aria-label="Play Next"
        >
          <CornerDownRight size={17} />
        </button>
      )}
      <button
        type="button"
        className="rm-icon-btn is-small"
        onClick={() => send({ type: "removeQueueItem", index, videoId: item.videoId })}
        aria-label="Remove from Up Next"
      >
        <X size={17} />
      </button>
    </Reorder.Item>
  );
}

// ---------------------------------------------------------------------------------------
// Search

/** Answers already received this visit, so retyping or deleting is instant. */
const searchCache = new Map<string, SearchHit[]>();
const SEARCH_CACHE_SIZE = 40;

function remember(key: string, results: SearchHit[]) {
  searchCache.delete(key);
  searchCache.set(key, results);
  if (searchCache.size > SEARCH_CACHE_SIZE) searchCache.delete(searchCache.keys().next().value!);
}

function SearchTab({
  query,
  onQueryChange,
  requestSearch,
  send,
  computer,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  requestSearch: RequestSearch;
  send: Send;
  computer: string;
}) {
  const key = query.trim().toLowerCase();
  const [results, setResults] = useState<SearchHit[]>(() => searchCache.get(key) ?? []);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<{ videoId: string; label: string } | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    if (key.length < SEARCH_MIN_CHARS) {
      latest.current++;
      setResults([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    const hit = searchCache.get(key);
    if (hit) {
      // Cached: show at once, no request.
      latest.current++;
      setResults(hit);
      setLoading(false);
      setFailed(false);
      return;
    }
    setLoading(true);
    const ticket = ++latest.current;
    const timer = window.setTimeout(() => {
      void requestSearch(query.trim()).then((answer) => {
        if (answer) remember(key, answer);
        // Only the newest query may fill the list; slower, older answers are dropped.
        if (ticket !== latest.current) return;
        setLoading(false);
        setFailed(answer === null);
        if (answer) setResults(answer);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key, query, requestSearch]);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(null), 1400);
    return () => window.clearTimeout(timer);
  }, [done]);

  const act = (type: "playTrack" | "playNextTrack" | "queueTrack", hit: SearchHit, label: string) => {
    send({
      type,
      track: { videoId: hit.videoId, title: hit.title, artist: hit.artist, thumbnailUrl: hit.thumbnailUrl },
    });
    setDone({ videoId: hit.videoId, label });
  };

  return (
    <section className="rm-search">
      <label className="rm-search-field">
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Songs, artists"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label="Search songs"
        />
        {loading && <span className="rm-search-spinner" aria-hidden="true" />}
        {query && !loading && (
          <button type="button" className="rm-search-clear" onClick={() => onQueryChange("")} aria-label="Clear search">
            <X size={15} />
          </button>
        )}
      </label>

      {failed && <p className="rm-note is-small">Your {computer} didn't answer. Check that it's online.</p>}
      {!failed && key.length >= SEARCH_MIN_CHARS && !loading && results.length === 0 && (
        <p className="rm-note is-small">No songs found.</p>
      )}

      {loading && results.length === 0 && (
        <ol className="rm-search-list" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="rm-queue-row is-skeleton">
              <span className="rm-queue-thumb rm-shimmer" />
              <span className="rm-skeleton-lines">
                <span className="rm-shimmer" />
                <span className="rm-shimmer" />
              </span>
            </li>
          ))}
        </ol>
      )}

      <ol className={`rm-search-list ${loading ? "is-stale" : ""}`}>
        {results.map((hit) => (
          <li key={hit.videoId} className="rm-queue-row">
            <button type="button" className="rm-queue-main" onClick={() => act("playTrack", hit, "Playing")}>
              <Art src={hit.thumbnailUrl} className="rm-queue-thumb" />
              <span className="rm-queue-text">
                <span className="rm-queue-title">{hit.title}</span>
                <span className="rm-queue-artist">
                  {done?.videoId === hit.videoId ? <strong className="rm-done">{done.label}</strong> : hit.artist}
                  {hit.duration && done?.videoId !== hit.videoId ? ` · ${hit.duration}` : ""}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="rm-icon-btn is-small"
              onClick={() => act("playNextTrack", hit, "Playing next")}
              aria-label="Play Next"
            >
              <CornerDownRight size={17} />
            </button>
            <button
              type="button"
              className="rm-icon-btn is-small"
              onClick={() => act("queueTrack", hit, "Added to Up Next")}
              aria-label="Add to Up Next"
            >
              <ListPlus size={18} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
