import { useCallback, useEffect, useRef, useState } from "react"
import { recordPlay, type Track } from "./data"
import type { usePlayer } from "./usePlayer"

/**
 * The TV playing by itself, with no desktop connected: a list of songs and where it is in
 * it. (While a desktop is connected, the desktop holds the queue and this stays empty.)
 */

/** Songs after the current one that are handed to a desktop that connects. */
const HANDED_ON = 50

interface Queue {
  tracks: Track[]
  index: number
}

/** A song that hasn't started this long after loading is skipped: YouTube shows "video
 *  unavailable" for some songs without ever raising an error. */
const START_TIMEOUT_MS = 15000
/** Songs skipped in a row before stopping, so a list of only blocked songs doesn't spin. */
const MAX_SKIPS_IN_A_ROW = 5
/** Seconds of playback before a song counts as played in YouTube Music history. */
const RECORD_AFTER_SECONDS = 10

export function useLocalQueue(player: ReturnType<typeof usePlayer>) {
  const [queue, setQueue] = useState<Queue | null>(null)
  const queueRef = useRef<Queue | null>(null)
  const { snapshot, load, seek } = player
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const skipsRef = useRef(0)
  const startedRef = useRef(false)
  const recordedRef = useRef<string | null>(null)

  const set = useCallback((next: Queue | null) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  const playAt = useCallback(
    (tracks: Track[], index: number) => {
      const track = tracks[index]
      if (!track) {
        set(null)
        return
      }
      startedRef.current = false
      set({ tracks, index })
      load(track.videoId, 0, true)
    },
    [load, set],
  )

  /** Plays `tracks` from `index`; the rest follow in order. */
  const play = useCallback(
    (tracks: Track[], index = 0) => {
      skipsRef.current = 0
      playAt(tracks, index)
    },
    [playAt],
  )

  const next = useCallback(() => {
    const now = queueRef.current
    if (now && now.index + 1 < now.tracks.length) playAt(now.tracks, now.index + 1)
  }, [playAt])

  const previous = useCallback(() => {
    const now = queueRef.current
    if (!now) return
    // Like every player: Previous restarts the song unless it has only just begun.
    if (snapshotRef.current.currentTime > 3 || now.index === 0) seek(0)
    else playAt(now.tracks, now.index - 1)
  }, [playAt, seek])

  /** A desktop took over the player. */
  const clear = useCallback(() => set(null), [set])

  /** Carries on a queue a desktop was playing here before it went away: the first song is
   *  already in the player, so nothing is loaded. */
  const adopt = useCallback(
    (tracks: Track[]) => {
      if (!tracks[0]) return
      startedRef.current = true
      skipsRef.current = 0
      // The desktop counted this play.
      recordedRef.current = tracks[0].videoId
      set({ tracks, index: 0 })
    },
    [set],
  )

  const skip = useCallback(() => {
    if (skipsRef.current >= MAX_SKIPS_IN_A_ROW) return
    skipsRef.current += 1
    next()
  }, [next])

  const active = queue !== null
  const videoId = queue?.tracks[queue.index]?.videoId

  useEffect(() => {
    if (!active || snapshot.videoId !== videoId) return
    if (snapshot.state === "playing") {
      startedRef.current = true
      skipsRef.current = 0
    } else if (snapshot.state === "ended") {
      next()
    } else if (snapshot.state === "error") {
      skip()
    }
  }, [active, videoId, snapshot.state, snapshot.videoId, next, skip])

  useEffect(() => {
    if (!active || !videoId) return
    const timer = setTimeout(() => {
      if (!startedRef.current && queueRef.current?.tracks[queueRef.current.index]?.videoId === videoId) skip()
    }, START_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [active, videoId, skip])

  useEffect(() => {
    if (!active || !videoId || snapshot.videoId !== videoId) return
    if (snapshot.state === "playing" && snapshot.currentTime >= RECORD_AFTER_SECONDS && recordedRef.current !== videoId) {
      recordedRef.current = videoId
      recordPlay(videoId, snapshot.duration, snapshot.currentTime)
    }
  }, [active, videoId, snapshot.videoId, snapshot.state, snapshot.currentTime, snapshot.duration])

  return {
    track: queue ? queue.tracks[queue.index] : null,
    upcoming: queue ? queue.tracks.slice(queue.index + 1, queue.index + 2) : [],
    /** The current song and what follows, for a desktop to carry on with. */
    handOn: queue ? queue.tracks.slice(queue.index, queue.index + 1 + HANDED_ON) : [],
    play,
    next,
    previous,
    clear,
    adopt,
  }
}
