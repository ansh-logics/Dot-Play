import { CassetteTape } from "../components/now-playing/CassetteTape";
import { activeRowIndex } from "../components/now-playing/lyricRows";
import type { SettledArtwork } from "../components/now-playing/useSettledArtwork";
import type { SearchResult } from "../lib/search";
import { formatTime, type NowPlaying } from "../tray/types";
import { clockParts, type LyricsResult } from "./hooks";

/*
 * Immersive mode in the Cassette style: the room goes dark and the deck's amber phosphor
 * display takes over. A big glowing clock (with the unlit segments faintly behind it, as on
 * a real fluorescent display) and the playing tape, its reels turning and winding with the
 * song. The lyrics display is the same phosphor screen (styled in Immersive.css).
 */

/** The playing song as a tape: CassetteTape takes a track and a settled cover. */
function tapeFor(np: NowPlaying): { track: SearchResult; art: SettledArtwork | null } {
  const videoId = np.videoId ?? `${np.title}::${np.artist}`;
  return {
    track: { videoId, title: np.title, artist: np.artist, thumbnailUrl: np.artworkUrl ?? "" },
    art: np.artworkUrl ? { url: np.artworkUrl, palette: null, videoId } : null,
  };
}

function Tape({ np, position, className }: { np: NowPlaying; position: number; className: string }) {
  const { track, art } = tapeFor(np);
  return (
    <div className={`${className}${np.isPlaying ? "" : " is-paused"}`}>
      <CassetteTape
        track={track}
        art={art}
        isPlaying={np.isPlaying}
        currentTime={position}
        duration={np.duration}
        reduceMotion={false}
      />
    </div>
  );
}

/** The time in phosphor, with "8"s for every digit glowing faintly behind it. */
function PhosphorClock({ now, className }: { now: Date; className: string }) {
  const { hour, minute } = clockParts(now);
  const text = `${hour}:${minute}`;
  return (
    <p className={className}>
      <span className="im-cas-unlit" aria-hidden="true">
        {text.replace(/\d/g, "8")}
      </span>
      <span className="im-cas-lit">
        {hour}
        <span className="im-cas-colon">:</span>
        {minute}
      </span>
    </p>
  );
}

/** Play state, time, and a dashed bar that fills like a bar-graph display. */
function TapeStatus({ np, position }: { np: NowPlaying; position: number }) {
  const duration = np.duration > 0 ? np.duration : 0;
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
  return (
    <div className="im-cas-status">
      <p className="im-cas-status-line">
        <span className={np.isPlaying ? "is-on" : ""}>{np.isPlaying ? "▶ Play" : "❚❚ Pause"}</span>
        <span>
          {formatTime(position)} / {formatTime(duration)}
        </span>
      </p>
      <div className="im-cas-bar">
        <div className="im-cas-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

interface CassetteStageProps {
  np: NowPlaying | null;
  now: Date;
  position: number;
  next: { title: string; artist: string } | null;
  lyrics: LyricsResult | null;
}

/** The clock display: phosphor clock and date, the sung line, the tape with what's on it. */
export function CassetteStage({ np, now, position, next, lyrics }: CassetteStageProps) {
  const { date } = clockParts(now);
  const rows = lyrics?.status === "synced" ? lyrics.rows : null;
  const row = rows ? rows[activeRowIndex(rows, position)] : null;
  const line = row?.kind === "line" ? row.line.text : "";
  return (
    <section className="im-cas-stage">
      <div className="im-cas-display">
        <p className="im-cas-date">{date}</p>
        <PhosphorClock now={now} className="im-cas-clock" />
        {rows && (
          <p key={row?.key ?? "none"} className="im-cas-line">
            {line || " "}
          </p>
        )}
      </div>
      {np ? (
        <div className="im-cas-deck">
          <Tape np={np} position={position} className="im-cas-tape" />
          <div className="im-cas-info">
            <p className="im-cas-title">{np.title}</p>
            <p className="im-cas-artist">{np.artist}</p>
            <TapeStatus np={np} position={position} />
            {next && (
              <p className="im-cas-next">
                <span>Next ▸</span> {next.title}
                {next.artist && ` · ${next.artist}`}
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="im-cas-empty">No tape</p>
      )}
    </section>
  );
}

/** The artwork display: the tape itself, big, turning, with a small phosphor clock. */
export function CassetteArt({ np, now, position }: { np: NowPlaying; now: Date; position: number }) {
  return (
    <section className="im-cas-art">
      <PhosphorClock now={now} className="im-cas-corner-clock" />
      <Tape np={np} position={position} className="im-cas-hero-tape" />
      <div className="im-cas-art-meta">
        <p className="im-cas-title">{np.title}</p>
        <p className="im-cas-artist">{np.artist}</p>
        <TapeStatus np={np} position={position} />
      </div>
    </section>
  );
}
