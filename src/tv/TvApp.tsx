import { useCallback, useEffect, useRef, useState } from "react"
import { Browse } from "./Browse"
import { loadShelves, type Shelf, type Track } from "./data"
import { PlaylistScreen } from "./PlaylistScreen"
import { LinkScreen, NowPlayingScreen } from "./screens"
import { useDpad } from "./useDpad"
import { useLink } from "./useLink"
import { useLocalQueue } from "./useLocalQueue"
import { usePlayer } from "./usePlayer"
import { useReceiver } from "./useReceiver"

/**
 * The TV app. Until a desktop links it, it shows the code to link with. After that it is two
 * things at once: a receiver a desktop can play on, and a player in its own right (browse
 * your playlists and YouTube Music's shelves with the remote). Whoever started the music
 * last holds the queue: the desktop, or the TV.
 *
 * Screens stack through the page history, so the remote's Back button walks back.
 */

type Screen = { name: "browse" } | { name: "playlist"; id: string; title: string; thumb: string } | { name: "now" }

const BROWSE: Screen = { name: "browse" }

export function TvApp() {
  const { link, profile, signOut } = useLink()
  const player = usePlayer()
  const local = useLocalQueue(player)
  const { play: playQueue, next: nextInQueue, previous: previousInQueue } = local
  const receiver = useReceiver(player, local.clear)
  const { snapshot, play, pause, seek } = player
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const [screen, setScreen] = useState<Screen>(BROWSE)
  const screenRef = useRef(screen)
  screenRef.current = screen

  useEffect(() => {
    history.replaceState(BROWSE, "")
    const onPop = (event: PopStateEvent) => setScreen((event.state as Screen | null) ?? BROWSE)
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const open = useCallback((next: Screen) => {
    // Now playing is never stacked on itself.
    if (next.name === "now" && screenRef.current.name === "now") return
    history.pushState(next, "")
    setScreen(next)
  }, [])

  // What is playing, and who decides what comes next.
  const fromDesktop = receiver.now?.track ?? null
  const track: Track | null = fromDesktop ?? local.track
  const next = fromDesktop ? receiver.now?.upcoming[0] : local.upcoming[0]
  const hasTrack = track !== null

  // A desktop starting to play here brings up now playing; music stopping leaves it.
  const desktopPlaying = fromDesktop !== null
  useEffect(() => {
    if (desktopPlaying) open({ name: "now" })
  }, [desktopPlaying, open])
  useEffect(() => {
    if (!hasTrack && screen.name === "now") history.back()
  }, [hasTrack, screen.name])

  const { release } = receiver
  const playHere = useCallback(
    (tracks: Track[], index: number) => {
      if (!tracks[index]) return
      // The TV's own choice: any desktop playing here is told it no longer is.
      release()
      playQueue(tracks, index)
      open({ name: "now" })
    },
    [release, playQueue, open],
  )

  // Home's shelves, kept while other screens are open.
  const signedIn = link?.signedIn ?? false
  const linked = (link?.linked.length ?? 0) > 0
  const [shelves, setShelves] = useState<Shelf[] | null>(null)
  const [shelvesError, setShelvesError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!linked) return
    let cancelled = false
    loadShelves(signedIn).then(
      (loaded) => {
        if (cancelled) return
        setShelves(loaded)
        setShelvesError(false)
      },
      () => {
        if (!cancelled) setShelvesError(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [linked, signedIn, attempt])

  // The remote. Media keys work everywhere; on now playing the arrows and OK drive the
  // song (elsewhere they move between buttons, see useDpad).
  const { sendKey } = receiver
  useEffect(() => {
    if (!hasTrack) return
    const skip = (key: "next" | "previous") => {
      if (desktopPlaying) sendKey(key)
      else if (key === "next") nextInQueue()
      else previousInQueue()
    }
    function onKey(event: KeyboardEvent) {
      const s = snapshotRef.current
      const onNow = screenRef.current.name === "now"
      switch (event.key) {
        case "MediaPlayPause":
          if (s.state === "playing") pause()
          else play()
          break
        case "MediaPlay":
          play()
          break
        case "MediaPause":
        case "MediaStop":
          pause()
          break
        case "MediaTrackNext":
          skip("next")
          break
        case "MediaTrackPrevious":
          skip("previous")
          break
        case "MediaFastForward":
          seek(s.currentTime + 10)
          break
        case "MediaRewind":
          seek(s.currentTime - 10)
          break
        case "Enter":
        case " ":
          if (!onNow) return
          if (s.state === "playing") pause()
          else play()
          break
        case "ArrowRight":
          if (!onNow) return
          seek(s.currentTime + 10)
          break
        case "ArrowLeft":
          if (!onNow) return
          seek(s.currentTime - 10)
          break
        case "ArrowUp":
          if (!onNow) return
          skip("next")
          break
        case "ArrowDown":
          if (!onNow) return
          skip("previous")
          break
        default:
          return
      }
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [hasTrack, desktopPlaying, play, pause, seek, sendKey, nextInQueue, previousInQueue])

  const showing = !link ? "blank" : !linked ? "link" : screen.name === "now" && track ? "now" : screen.name === "playlist" ? "playlist" : "browse"
  const [playlistReady, setPlaylistReady] = useState(0)
  const navKey = showing === "playlist" && screen.name === "playlist" ? `playlist:${screen.id}` : showing
  useDpad(navKey, showing === "browse" ? shelves !== null || shelvesError : showing === "playlist" ? playlistReady > 0 : false)

  const fromName =
    fromDesktop && link ? (link.linked.find((desktop) => link.online.includes(desktop.id))?.name ?? "your computer") : null

  return (
    <>
      {showing === "blank" || !link ? (
        <main className="tv" />
      ) : showing === "link" ? (
        <LinkScreen name={link.name} code={link.code} />
      ) : showing === "now" && track ? (
        <NowPlayingScreen track={track} next={next} snapshot={snapshot} from={fromName} />
      ) : showing === "playlist" && screen.name === "playlist" ? (
        <PlaylistScreen
          key={screen.id}
          playlistId={screen.id}
          cardTitle={screen.title}
          cardThumb={screen.thumb}
          onPlay={playHere}
          onReady={() => setPlaylistReady((n) => n + 1)}
        />
      ) : (
        <Browse
          link={link}
          profile={profile}
          shelves={shelves}
          error={shelvesError}
          onRetry={() => {
            setShelvesError(false)
            setAttempt((n) => n + 1)
          }}
          playing={track}
          onOpenNow={() => open({ name: "now" })}
          onOpenPlaylist={(item) => {
            if (!item.playlistId) return
            setPlaylistReady(0)
            open({ name: "playlist", id: item.playlistId, title: item.title, thumb: item.thumb })
          }}
          onPlay={playHere}
          onSignOut={signOut}
        />
      )}
      <div ref={player.containerRef} className="tv-engine" aria-hidden="true" />
    </>
  )
}
