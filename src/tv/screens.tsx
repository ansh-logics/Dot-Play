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
  snapshot: PlayerSnapshot
  /** The computer playing here, when it isn't the TV's own choice. */
  from: string | null
}

export function NowPlayingScreen({ track, next, snapshot, from }: NowPlayingProps) {
  const progress = snapshot.duration > 0 ? Math.min(1, snapshot.currentTime / snapshot.duration) : 0
  const status =
    snapshot.state === "paused" || snapshot.state === "cued"
      ? "Paused"
      : snapshot.state === "playing" || snapshot.state === "ended"
        ? null
        : snapshot.state === "error"
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
          {from && <p className="tv-now-from">Playing from {from}</p>}
        </div>
      </div>

      <div className="tv-progress">
        <span>{clock(snapshot.currentTime)}</span>
        <div className="tv-progress-track">
          <div className="tv-progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <span>{snapshot.duration > 0 ? clock(snapshot.duration) : "–:––"}</span>
      </div>

      <p className="tv-next">
        {next ? (
          <>
            <span>Next</span>
            {next.title} · {next.artist}
          </>
        ) : (
          <span>OK pause · ◀ ▶ seek · ▲ ▼ next / previous · Back to browse</span>
        )}
      </p>
    </main>
  )
}
