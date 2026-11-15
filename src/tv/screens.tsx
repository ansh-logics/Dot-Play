import type { Track } from "./data"
import type { PlayerSnapshot } from "./usePlayer"

export function Wordmark() {
  return (
    <h1 className="tv-wordmark">
      dot<span>(.)</span>play
    </h1>
  )
}

/** Shown until a desktop app links this TV: the code it needs, and where to type it. */
export function LinkScreen({ name, code }: { name: string; code: string }) {
  return (
    <main className="tv tv-link">
      <Wordmark />
      <div className="tv-link-body">
        <div className="tv-link-steps">
          <h2>Link this TV</h2>
          <ol>
            <li>Open dot(.)music on your computer, on the same Wi-Fi as this TV.</li>
            <li>
              Go to Settings, then TVs, and choose <strong>{name}</strong>.
            </li>
            <li>Type this code.</li>
          </ol>
        </div>
        <div className="tv-code" aria-label={`Code ${code.split("").join(" ")}`}>
          {code.split("").map((digit, index) => (
            <span key={index}>{digit}</span>
          ))}
        </div>
      </div>
      <p className="tv-footnote">Your account is sent from your computer, encrypted. Nothing is typed on the TV.</p>
    </main>
  )
}

export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

interface NowPlayingProps {
  track: Track
  next: Track | undefined
  /** The song's state and position, wherever it is playing. */
  playback: Pick<PlayerSnapshot, "state" | "currentTime" | "duration">
  /** "Playing on this TV" / "Playing on <computer>"; null when the TV plays by itself. */
  where: string | null
  /** Moves the sound between this TV and the computer; null when there is no computer. */
  move: { label: string; run: () => void } | null
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
}

export function NowPlayingScreen({ track, next, playback, where, move, onToggle, onPrevious, onNext }: NowPlayingProps) {
  const progress = playback.duration > 0 ? Math.min(1, playback.currentTime / playback.duration) : 0
  const playing = playback.state === "playing" || playback.state === "buffering"
  const status =
    playback.state === "paused" || playback.state === "cued"
      ? "Paused"
      : playback.state === "playing" || playback.state === "ended"
        ? null
        : playback.state === "error"
          ? "This song can't be played here"
          : "Loading…"

  return (
    <main className="tv tv-now">
      <div className="tv-now-main">
        {track.thumb ? <img className="tv-art" src={track.thumb} alt="" referrerPolicy="no-referrer" /> : <div className="tv-art" />}
        <div className="tv-now-text">
          <Wordmark />
          <h2>{track.title}</h2>
          <p className="tv-artist">{track.artist}</p>
          {status && <p className="tv-now-status">{status}</p>}
          {where && <p className="tv-now-from">{where}</p>}
        </div>
      </div>

      <div className="tv-progress">
        <span>{clock(playback.currentTime)}</span>
        <div className="tv-progress-track">
          <div className="tv-progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <span>{playback.duration > 0 ? clock(playback.duration) : "–:––"}</span>
      </div>

      <div className="tv-controls" data-nav-row>
        <button type="button" className="tv-button" data-nav-id="previous" onClick={onPrevious}>
          Previous
        </button>
        <button type="button" className="tv-button tv-control-main" data-nav-id="toggle" data-nav-default="" onClick={onToggle}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" className="tv-button" data-nav-id="next" onClick={onNext}>
          Next
        </button>
        {move && (
          <button type="button" className="tv-button tv-control-move" data-nav-id="move" onClick={move.run}>
            {move.label}
          </button>
        )}
      </div>

      <p className="tv-next">
        {next ? (
          <>
            <span>Next</span>
            {next.title} · {next.artist}
          </>
        ) : (
          <span>Back to browse</span>
        )}
      </p>
    </main>
  )
}
