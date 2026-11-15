import { useMemo, type CSSProperties } from "react"
import { Loader2, Pause, Play, SkipBack, SkipForward } from "lucide-react"
import "../components/now-playing/NowPlaying.css"
import { LyricsPanel } from "../components/now-playing/LyricsPanel"
import { NowPlayingBackdrop } from "../components/now-playing/NowPlayingBackdrop"
import { SettledArt } from "../components/now-playing/SettledArt"
import { useLyrics } from "../components/now-playing/useLyrics"
import { useSettledArtwork } from "../components/now-playing/useSettledArtwork"
import { VinylRecord } from "../components/now-playing/VinylRecord"
import { cleanDisplayTitle } from "../lib/displayText"
import type { SearchResult } from "../lib/search"
import type { Track } from "./data"
import type { PlayerSnapshot } from "./usePlayer"

/**
 * Now playing on the TV: the desktop's full-screen player, drawn with the same pieces (the
 * album-tinted backdrop, the cover, the synced lyrics, the glass control card) and in the
 * style chosen there. Only the controls differ: a remote has no pointer, so the card holds
 * the few buttons Left, Right and OK can reach.
 */

/** The player styles this screen can draw; anything else falls back to the first. */
const SKINS = new Set(["apple", "nothing", "vinyl"])

export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

interface NowPlayingTvProps {
  track: Track
  /** The song's state and position, wherever it is playing. */
  playback: Pick<PlayerSnapshot, "state" | "currentTime" | "duration">
  /** The player style chosen on the computer. */
  skin: string | undefined
  /** "Playing on this TV" / "Playing on <computer>"; null when the TV plays by itself. */
  where: string | null
  /** Moves the sound between this TV and the computer; null when there is no computer. */
  move: { label: string; run: () => void } | null
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
  onSeek: (seconds: number) => void
}

export function NowPlayingTv({ track, playback, skin, where, move, onToggle, onPrevious, onNext, onSeek }: NowPlayingTvProps) {
  // The desktop's pieces take a song in the shape its queue holds.
  const song: SearchResult = useMemo(
    () => ({ videoId: track.videoId, title: track.title, artist: track.artist, thumbnailUrl: track.thumb }),
    [track.videoId, track.title, track.artist, track.thumb],
  )
  const art = useSettledArtwork(song)
  const { data: lyrics, status: lyricsStatus } = useLyrics(song, playback.duration)
  const hasLyrics = lyricsStatus === "synced" || lyricsStatus === "plain" || lyricsStatus === "loading"
  const look = skin && SKINS.has(skin) ? skin : "apple"

  const playing = playback.state === "playing"
  const busy = playback.state === "buffering" || playback.state === "unstarted" || playback.state === "loading"
  const failed = playback.state === "error"
  const progress = playback.duration > 0 ? Math.min(1, playback.currentTime / playback.duration) : 0

  return (
    <main
      className="np-root tv-np"
      data-skin={look}
      style={{ ["--np-art-zoom" as string]: art?.palette?.zoom ?? 1 } as CSSProperties}
    >
      <NowPlayingBackdrop palette={art?.palette ?? null} artworkUrl={art?.url} />

      <div className={`np-stage ${hasLyrics ? "has-lyrics" : "art-only"}`}>
        <div className="np-stage-row">
          <div className="np-art-wrap">
            {look === "vinyl" ? (
              <VinylRecord
                track={song}
                art={art}
                isPlaying={playing}
                currentTime={playback.currentTime}
                duration={playback.duration}
                reduceMotion={false}
              />
            ) : (
              <SettledArt art={art} alt="" />
            )}
          </div>
          {hasLyrics && (
            <section className="np-lyrics-col">
              <LyricsPanel
                data={lyrics}
                status={lyricsStatus}
                currentTime={playback.currentTime}
                isPlaying={playing}
                onSeek={onSeek}
                reduceMotion={false}
                trackKey={track.videoId}
              />
            </section>
          )}
        </div>
        <div className="np-meta">
          <h1 className="np-title">{cleanDisplayTitle(track.title)}</h1>
          <p className={`np-artist ${failed ? "is-error" : ""}`}>{failed ? "This song can't be played here" : track.artist}</p>
        </div>
      </div>

      <div className="np-card-dock">
        <div className="np-card">
          <div className="np-card-peek">
            <div className="np-deck">
              <div className="np-progress">
                <div className="np-slider" style={{ ["--np-pct" as string]: `${progress * 100}%` } as CSSProperties}>
                  <div className="np-slider-rail">
                    <div className="np-slider-fill" />
                  </div>
                  <div className="np-slider-knob" />
                </div>
                <div className="np-times" aria-hidden="true">
                  <span>{clock(playback.currentTime)}</span>
                  <span>{playback.duration > 0 ? clock(playback.duration) : "–:––"}</span>
                </div>
              </div>

              <div className="np-deck-row" data-nav-row>
                <div className="tv-np-where">{where}</div>
                <div className="np-transport">
                  <button type="button" className="np-skip" data-nav-id="previous" onClick={onPrevious} aria-label="Previous">
                    <SkipBack size={22} fill="currentColor" strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    className="np-play"
                    data-nav-id="toggle"
                    data-nav-default=""
                    onClick={onToggle}
                    aria-label={playing ? "Pause" : "Play"}
                  >
                    {busy ? (
                      <Loader2 size={18} className="np-spin" />
                    ) : playing ? (
                      <Pause size={18} fill="currentColor" strokeWidth={0} />
                    ) : (
                      <Play size={18} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />
                    )}
                  </button>
                  <button type="button" className="np-skip" data-nav-id="next" onClick={onNext} aria-label="Next">
                    <SkipForward size={22} fill="currentColor" strokeWidth={1.5} />
                  </button>
                </div>
                <div className="np-deck-end">
                  {move && (
                    <button type="button" className="np-pill tv-np-move" data-nav-id="move" onClick={move.run}>
                      {move.label}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
