import { useEffect, useState } from "react"
import { loadPlaylist, type Playlist, type Track } from "./data"

/** The most rows drawn at once; a 1 GB TV has no room for a thousand buttons. */
const MAX_ROWS = 150

interface PlaylistProps {
  playlistId: string
  /** The title and artwork of the card that was opened: YouTube Music's own answer for
   *  some playlists (your own, Liked Music) is just "Playlist" with no picture. */
  cardTitle: string
  cardThumb: string
  onPlay: (tracks: Track[], index: number) => void
  /** Called once the songs are on screen, so the remote has somewhere to land. */
  onReady: () => void
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function PlaylistScreen({ playlistId, cardTitle, cardThumb, onPlay, onReady }: PlaylistProps) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    loadPlaylist(playlistId).then(
      (loaded) => {
        if (cancelled) return
        setPlaylist(loaded)
        setFailed(false)
        onReady()
      },
      () => {
        if (cancelled) return
        setFailed(true)
        onReady()
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistId, attempt])

  if (failed) {
    return (
      <main className="tv tv-playlist">
        <div className="tv-row" data-nav-row>
          <button type="button" className="tv-button" data-nav-default onClick={() => setAttempt((n) => n + 1)}>
            Couldn't open this. Press OK to try again
          </button>
        </div>
      </main>
    )
  }
  if (!playlist) {
    return (
      <main className="tv tv-playlist">
        <p className="tv-loading">Opening…</p>
      </main>
    )
  }

  const { tracks } = playlist
  const title = !playlist.title || playlist.title === "Playlist" ? cardTitle || playlist.title : playlist.title
  const thumb = playlist.thumb || cardThumb
  return (
    <main className="tv tv-playlist">
      <header className="tv-playlist-head">
        {thumb ? <img src={thumb} alt="" referrerPolicy="no-referrer" /> : <div className="tv-card-blank" />}
        <div>
          <h2>{title}</h2>
          <p>{playlist.subtitle}</p>
          <div className="tv-row" data-nav-row>
            <button type="button" className="tv-button" data-nav-default disabled={tracks.length === 0} onClick={() => onPlay(tracks, 0)}>
              Play
            </button>
            <button type="button" className="tv-button" disabled={tracks.length < 2} onClick={() => onPlay(shuffled(tracks), 0)}>
              Shuffle
            </button>
          </div>
        </div>
      </header>

      <div className="tv-tracks">
        {tracks.length === 0 && <p className="tv-loading">Nothing here can be played.</p>}
        {tracks.slice(0, MAX_ROWS).map((track, index) => (
          <div key={`${track.videoId}:${index}`} data-nav-row>
            <button type="button" className="tv-track" data-nav-id={`track:${index}`} onClick={() => onPlay(tracks, index)}>
              <span className="tv-track-index">{index + 1}</span>
              <span className="tv-track-title">{track.title}</span>
              <span className="tv-track-artist">{track.artist}</span>
              <span className="tv-track-time">{track.duration}</span>
            </button>
          </div>
        ))}
        {tracks.length > MAX_ROWS && <p className="tv-loading">And {tracks.length - MAX_ROWS} more, which play in order.</p>}
      </div>
    </main>
  )
}
