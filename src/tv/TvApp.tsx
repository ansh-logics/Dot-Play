import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Browse } from "./Browse"
import { loadShelves, type Shelf, type Track } from "./data"
import { PlaylistScreen } from "./PlaylistScreen"
import { NowPlayingTv } from "./NowPlayingTv"
import { LinkScreen } from "./screens"
import { useDpad } from "./useDpad"
import { useLink } from "./useLink"
import { useLocalQueue } from "./useLocalQueue"
import { usePlayer } from "./usePlayer"
import { useReceiver, useRemoteTime } from "./useReceiver"

/**
 * The TV app. Until a desktop links it, it shows the code to link with. After that it is
 * one half of a pair, like any two devices on one music account: while a desktop is
 * connected there is one queue (the desktop's), both show it and both control it, and the
 * sound comes out of one of them. With no desktop connected the TV plays by itself, and
 * hands what it is playing to the next desktop that connects.
 *
 * Screens stack through the page history, so the remote's Back button walks back.
 */

type Screen = { name: "browse" } | { name: "playlist"; id: string; title: string; thumb: string } | { name: "now" }

const BROWSE: Screen = { name: "browse" }

export function TvApp() {
  const { link, profile, signOut } = useLink()
  const player = usePlayer()
  const local = useLocalQueue(player)
  const { play: playQueue, next: nextInQueue, previous: previousInQueue, clear: clearQueue, adopt: adoptQueue } = local
  const ownQueue = local.track !== null
  const receiver = useReceiver(player, { ownQueue, onTakeover: clearQueue })
  const { now, command, take, give, pick, offer, forget } = receiver
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

  // What is playing, who decides what comes next, and where the sound comes out. The TV's
  // own queue only exists while no desktop is deciding.
  const following = ownQueue ? null : now
  const track: Track | null = local.track ?? now?.track ?? null
  const hasTrack = track !== null
  const soundHere = ownQueue || following?.on === "tv"
  const remoteTime = useRemoteTime(receiver.remote)
  /** The song's state and position: this TV's player, or the desktop's when it is the speaker. */
  const playback = soundHere
    ? { state: snapshot.state, currentTime: snapshot.currentTime, duration: snapshot.duration }
    : receiver.remote && receiver.remote.videoId === track?.videoId
      ? { state: receiver.remote.state, currentTime: remoteTime, duration: receiver.remote.duration }
      : { state: "paused" as const, currentTime: 0, duration: 0 }
  const playbackRef = useRef(playback)
  playbackRef.current = playback

  const anyDesktop = (link?.online.length ?? 0) > 0
  const desktopName = link?.linked.find((desktop) => link.online.includes(desktop.id))?.name ?? "your computer"

  // Desktops coming and going. When the last one leaves while this TV is its speaker, the TV
  // carries on alone with the rest of that queue; music that was playing on the desktop left
  // with it. A connected desktop is offered what the TV is playing by itself, at every song,
  // so it joins in as soon as it isn't playing something of its own.
  const handOnRef = useRef(local.handOn)
  handOnRef.current = local.handOn
  const nowRef = useRef(now)
  nowRef.current = now
  const linkKnown = link !== null
  useEffect(() => {
    if (!linkKnown || anyDesktop) return
    const was = nowRef.current
    if (was?.on === "tv" && snapshotRef.current.videoId === was.track.videoId) adoptQueue([was.track, ...was.upcoming])
    forget()
  }, [linkKnown, anyDesktop, adoptQueue, forget])
  const playingAlone = ownQueue && snapshot.state === "playing"
  useEffect(() => {
    if (anyDesktop && playingAlone) offer(handOnRef.current)
  }, [anyDesktop, playingAlone, offer])

  // The desktop says this TV is its speaker while the TV still holds a queue of its own:
  // either the desktop just picked that queue up (same song: let go of it, the music plays
  // on), or the two disagree and the desktop is told again what is really playing here.
  const nowOn = now?.on
  const nowVideoId = now?.track.videoId
  const ownVideoId = local.track?.videoId
  useEffect(() => {
    if (!ownVideoId || nowOn !== "tv") return
    if (nowVideoId === ownVideoId) clearQueue()
    else offer(handOnRef.current)
  }, [nowOn, nowVideoId, ownVideoId, clearQueue, offer])

  // The sound moving to this TV brings up now playing, and so does the song asked for from
  // this TV's own shelves; music stopping leaves it.
  const pickedRef = useRef<string | null>(null)
  const speakerForDesktop = following?.on === "tv"
  useEffect(() => {
    if (speakerForDesktop) open({ name: "now" })
  }, [speakerForDesktop, open])
  useEffect(() => {
    if (nowVideoId && pickedRef.current === nowVideoId) {
      pickedRef.current = null
      open({ name: "now" })
    }
  }, [nowVideoId, open])
  useEffect(() => {
    if (!hasTrack && screen.name === "now") history.back()
  }, [hasTrack, screen.name])

  const playHere = useCallback(
    (tracks: Track[], index: number) => {
      const chosen = tracks[index]
      if (!chosen) return
      if (anyDesktop) {
        // One queue: the desktop's. It plays the song on this TV.
        pickedRef.current = chosen.videoId
        pick(tracks.slice(index, index + 100), 0)
        if (nowRef.current?.track.videoId === chosen.videoId) open({ name: "now" })
        return
      }
      playQueue(tracks, index)
      open({ name: "now" })
    },
    [anyDesktop, pick, playQueue, open],
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

  // What the remote does to the music. When this TV is the speaker, play, pause and seek act
  // on its own player (the desktop hears about it); everything else is the queue's business.
  const controls = useMemo(() => {
    const toggle = () => {
      if (!soundHere) command({ cmd: "toggle" })
      else if (snapshotRef.current.state === "playing") pause()
      else play()
    }
    const setPlaying = (playing: boolean) => {
      if (!soundHere) command({ cmd: playing ? "play" : "pause" })
      else if (playing) play()
      else pause()
    }
    const skip = (key: "next" | "previous") => {
      if (!ownQueue) command({ cmd: key })
      else if (key === "next") nextInQueue()
      else previousInQueue()
    }
    const seekBy = (delta: number) => {
      const target = Math.max(0, playbackRef.current.currentTime + delta)
      if (soundHere) seek(target)
      else command({ cmd: "seek", seconds: target })
    }
    const seekTo = (seconds: number) => {
      if (soundHere) seek(seconds)
      else command({ cmd: "seek", seconds })
    }
    return { toggle, setPlaying, skip, seekBy, seekTo }
  }, [soundHere, ownQueue, command, play, pause, seek, nextInQueue, previousInQueue])

  // Media keys work on every screen. (On now playing the arrows move between its buttons.)
  useEffect(() => {
    if (!hasTrack) return
    function onKey(event: KeyboardEvent) {
      switch (event.key) {
        case "MediaPlayPause":
          controls.toggle()
          break
        case "MediaPlay":
          controls.setPlaying(true)
          break
        case "MediaPause":
        case "MediaStop":
          controls.setPlaying(false)
          break
        case "MediaTrackNext":
          controls.skip("next")
          break
        case "MediaTrackPrevious":
          controls.skip("previous")
          break
        case "MediaFastForward":
          controls.seekBy(10)
          break
        case "MediaRewind":
          controls.seekBy(-10)
          break
        default:
          return
      }
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [hasTrack, controls])

  const showing = !link ? "blank" : !linked ? "link" : screen.name === "now" && track ? "now" : screen.name === "playlist" ? "playlist" : "browse"
  const [playlistReady, setPlaylistReady] = useState(0)
  const navKey = showing === "playlist" && screen.name === "playlist" ? `playlist:${screen.id}` : showing
  useDpad(
    navKey,
    showing === "browse" ? shelves !== null || shelvesError : showing === "playlist" ? playlistReady > 0 : showing === "now",
  )

  // Where the sound is, in words, and the button that moves it (only with a desktop to move it to or from).
  const where = !following ? null : following.on === "tv" ? "Playing on this TV" : `Playing on ${desktopName}`
  const move = !following
    ? null
    : following.on === "tv"
      ? { label: `Play on ${desktopName}`, run: give }
      : { label: "Play on this TV", run: take }

  return (
    <>
      {showing === "blank" || !link ? (
        <main className="tv" />
      ) : showing === "link" ? (
        <LinkScreen name={link.name} code={link.code} />
      ) : showing === "now" && track ? (
        <NowPlayingTv
          track={track}
          playback={playback}
          skin={now?.skin}
          where={where}
          move={move}
          onToggle={controls.toggle}
          onPrevious={() => controls.skip("previous")}
          onNext={() => controls.skip("next")}
          onSeek={controls.seekTo}
        />
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
          where={where}
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
