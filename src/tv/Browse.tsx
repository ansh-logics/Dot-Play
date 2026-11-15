import { useEffect, useState } from "react"
import type { Shelf, ShelfItem, Track } from "./data"
import { Wordmark } from "./screens"
import type { LinkState, Profile } from "./useLink"

interface BrowseProps {
  link: LinkState
  profile: Profile | null
  shelves: Shelf[] | null
  error: boolean
  onRetry: () => void
  /** What is playing, for the way back to it. */
  playing: Track | null
  onOpenNow: () => void
  onOpenPlaylist: (item: ShelfItem) => void
  onPlay: (tracks: Track[], index: number) => void
  onSignOut: () => void
}

/** The TV's home: your playlists and YouTube Music's shelves, walked with the remote. */
export function Browse(props: BrowseProps) {
  const { link, profile, shelves } = props
  // Signing out takes two presses of OK, so a stray press doesn't do it.
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(timer)
  }, [confirming])

  const connected = link.linked.filter((desktop) => link.online.includes(desktop.id))

  return (
    <main className="tv tv-browse">
      <header className="tv-home-top">
        <Wordmark />
        <div className="tv-account">
          {profile?.avatarUrl && <img src={profile.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <span>{link.signedIn ? (profile?.name ?? "Signed in") : "Not signed in"}</span>
        </div>
      </header>

      <div className="tv-browse-scroll">
        {props.playing && (
          <div className="tv-row" data-nav-row>
            <button type="button" className="tv-now-pill" data-nav-id="now" onClick={props.onOpenNow}>
              <span className="tv-now-pill-label">Now playing</span>
              {props.playing.title} · {props.playing.artist}
            </button>
          </div>
        )}

        {!link.signedIn && (
          <p className="tv-note">Sign in to dot(.)music on your computer and this TV signs in with it.</p>
        )}

        {shelves === null && !props.error && <p className="tv-loading">Loading your music…</p>}
        {props.error && (
          <div className="tv-row" data-nav-row>
            <button type="button" className="tv-button" data-nav-default onClick={props.onRetry}>
              Couldn't load your music. Press OK to try again
            </button>
          </div>
        )}

        {shelves?.map((shelf, shelfIndex) => {
          const songs = shelf.items.filter((item) => !item.playlistId && item.videoId)
          return (
            <section key={`${shelfIndex}:${shelf.title}`} className="tv-shelf">
              <h3>{shelf.title}</h3>
              <div className="tv-shelf-row" data-nav-row>
                {shelf.items.map((item, itemIndex) => (
                  <button
                    key={`${item.playlistId ?? item.videoId}:${itemIndex}`}
                    type="button"
                    className="tv-card"
                    data-nav-id={`${shelfIndex}:${itemIndex}`}
                    data-nav-default={shelfIndex === 0 && itemIndex === 0 ? "" : undefined}
                    onClick={() => {
                      if (item.playlistId) props.onOpenPlaylist(item)
                      else props.onPlay(songs, songs.indexOf(item))
                    }}
                  >
                    {item.thumb ? (
                      <img src={item.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="tv-card-blank" />
                    )}
                    <span className="tv-card-title">{item.title}</span>
                    <span className="tv-card-sub">{item.artist}</span>
                  </button>
                ))}
              </div>
            </section>
          )
        })}

        <div className="tv-row tv-browse-foot" data-nav-row>
          <button
            type="button"
            className="tv-button"
            data-nav-id="sign-out"
            onClick={() => {
              if (confirming) props.onSignOut()
              else setConfirming(true)
            }}
          >
            {confirming ? "Press OK again to sign out" : "Sign out of this TV"}
          </button>
          <span className={`tv-status ${connected.length > 0 ? "is-on" : ""}`}>
            <span className="tv-status-dot" />
            {connected.length > 0
              ? `Connected to ${connected.map((d) => d.name).join(", ")}`
              : `Linked to ${link.linked.map((d) => d.name).join(", ")}`}
          </span>
        </div>
      </div>
    </main>
  )
}
