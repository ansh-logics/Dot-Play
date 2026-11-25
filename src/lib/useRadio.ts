import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { radioStatic } from "./feedback"
import { findStation, type RadioStation } from "./radioStations"
import { searchTracks, type SearchResult } from "./search"
import { cacheTracks } from "./trackCache"

/** The parts of usePlayback the radio drives. */
export interface RadioPlayback {
  currentTrack: SearchResult | null
  session: { upcoming: SearchResult[] }
  duration: number
  volume: number
  isMuted: boolean
  selectTrack: (track: SearchResult, contextList?: SearchResult[]) => void
  appendStationTracks: (tracks: SearchResult[]) => void
  seekTo: (seconds: number) => void
  setDuck: (gain: number) => void
  suspendAutoplay: (suspended: boolean) => void
  togglePlayPause: () => void
  playerState: string
}

export type RadioStatus = "off" | "tuning" | "on"

const LAST_STATION_KEY = "dot_gta_station"
const RESOLVED_KEY = "dot_radio_resolved"
/** Keep at least this many station songs waiting, so crossfade always has a next song. */
const KEEP_AHEAD = 3
/** A song that couldn't be found is retried after a week. */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Resolved = Pick<SearchResult, "videoId" | "title" | "artist" | "thumbnailUrl"> | { miss: number }
let resolvedCache: Record<string, Resolved> | null = null

function loadResolved(): Record<string, Resolved> {
  if (resolvedCache) return resolvedCache
  try {
    resolvedCache = JSON.parse(localStorage.getItem(RESOLVED_KEY) ?? "{}") ?? {}
  } catch {
    resolvedCache = {}
  }
  return resolvedCache!
}

function saveResolved(): void {
  try {
    localStorage.setItem(RESOLVED_KEY, JSON.stringify(resolvedCache ?? {}))
  } catch {
    // ignore (storage full): we just search again next time
  }
}

const songKey = ([artist, title]: [string, string]) => `${artist}|${title}`.toLowerCase()

/** One station song to a playable track: our own cache first, then a search. */
async function resolveSong(song: [string, string]): Promise<SearchResult | null> {
  const cache = loadResolved()
  const key = songKey(song)
  const hit = cache[key]
  if (hit && "videoId" in hit) return { ...hit, itemType: "song" }
  if (hit && "miss" in hit && Date.now() - hit.miss < MISS_TTL_MS) return null
  try {
    const results = await searchTracks(`${song[0]} ${song[1]}`)
    const best = results.find((r) => r.videoId && r.itemType !== "playlist")
    if (!best) {
      cache[key] = { miss: Date.now() }
      saveResolved()
      return null
    }
    cache[key] = { videoId: best.videoId, title: best.title, artist: best.artist, thumbnailUrl: best.thumbnailUrl }
    saveResolved()
    cacheTracks([best])
    return { ...best, queueSource: undefined }
  } catch (err) {
    console.warn("[DOT Music] Radio couldn't find a song:", song, err)
    return null
  }
}

function shuffled(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

function loadLastStation(): string | null {
  try {
    return localStorage.getItem(LAST_STATION_KEY)
  } catch {
    return null
  }
}

/**
 * GTA-style radio. Tuning in plays static, starts a station song part-way through (as if
 * it were already on air), and keeps a few more of the station's songs queued so it never
 * ends and never drifts into unrelated recommendations. Picking any other song switches
 * the radio off, because that drops the station's songs from the queue.
 */
export function useRadio(playback: RadioPlayback) {
  const [stationId, setStationId] = useState<string | null>(null)
  const [status, setStatus] = useState<RadioStatus>("off")
  const [lastStationId, setLastStationId] = useState<string | null>(loadLastStation)
  const station = useMemo(() => findStation(stationId), [stationId])

  const playbackRef = useRef(playback)
  useEffect(() => {
    playbackRef.current = playback
  })

  /** Shuffled song order for the station and where we are in it. */
  const bagRef = useRef<{ stationId: string; order: number[]; pos: number } | null>(null)
  /** videoIds this station has queued, to tell its songs from anything else. */
  const stationIdsRef = useRef<Set<string>>(new Set())
  /** Bumped on every tune/off so slow searches from an old station are ignored. */
  const epochRef = useRef(0)
  /** The epoch of the refill in flight, if any; a stale one must not block the new station. */
  const refillEpochRef = useRef<number | null>(null)
  const [refillTick, setRefillTick] = useState(0)
  /** Station songs already played this session, so repeat-all's recycled songs don't count as "waiting". */
  const playedRef = useRef<Set<string>>(new Set())
  const liveSeekRef = useRef<string | null>(null)
  const unduckTimerRef = useRef<number | null>(null)

  const nextSongs = useCallback(async (s: RadioStation, count: number, epoch: number): Promise<SearchResult[]> => {
    const out: SearchResult[] = []
    let attempts = 0
    while (out.length < count && attempts < s.songs.length && epochRef.current === epoch) {
      let bag = bagRef.current
      if (!bag || bag.stationId !== s.id || bag.pos >= bag.order.length) {
        bag = bagRef.current = { stationId: s.id, order: shuffled(s.songs.length), pos: 0 }
      }
      const song = s.songs[bag.order[bag.pos++]]
      attempts++
      const track = await resolveSong(song)
      if (!track || out.some((t) => t.videoId === track.videoId)) continue
      // Small stations loop: avoid repeating the song that is playing right now.
      if (track.videoId === playbackRef.current.currentTrack?.videoId && s.songs.length > 1) continue
      out.push(track)
    }
    return out
  }, [])

  const unduck = useCallback((afterMs: number) => {
    if (unduckTimerRef.current) window.clearTimeout(unduckTimerRef.current)
    unduckTimerRef.current = window.setTimeout(() => {
      unduckTimerRef.current = null
      playbackRef.current.setDuck(1)
    }, afterMs)
  }, [])

  const staticBurst = useCallback((seconds?: number) => {
    const p = playbackRef.current
    radioStatic(p.isMuted ? 0 : p.volume / 100, seconds)
  }, [])

  const tune = useCallback(
    async (id: string) => {
      const s = findStation(id)
      if (!s) return
      const epoch = ++epochRef.current
      setStationId(s.id)
      setStatus("tuning")
      setLastStationId(s.id)
      try {
        localStorage.setItem(LAST_STATION_KEY, s.id)
      } catch {
        // ignore
      }
      bagRef.current = null
      playedRef.current = new Set()
      playbackRef.current.setDuck(0.15)
      staticBurst(0.7)
      const playingBefore = playbackRef.current.currentTrack?.videoId

      const first = await nextSongs(s, 1, epoch)
      if (epochRef.current !== epoch) return
      // The listener picked something else while we were searching: their choice wins.
      const pickedMeanwhile = playbackRef.current.currentTrack?.videoId !== playingBefore
      if (first.length === 0 || pickedMeanwhile) {
        setStatus("off")
        setStationId(null)
        playbackRef.current.setDuck(1)
        return
      }
      stationIdsRef.current = new Set(first.map((t) => t.videoId))
      liveSeekRef.current = first[0].videoId
      // Before selecting: the autoplay effect runs in the same commit and must not fill the queue.
      playbackRef.current.suspendAutoplay(true)
      playbackRef.current.selectTrack(first[0], [])
      staticBurst(0.35)
      setStatus("on")
      // Safety net: never leave the music ducked if the live seek doesn't happen.
      unduck(2500)
    },
    [nextSongs, staticBurst, unduck],
  )

  const off = useCallback(() => {
    epochRef.current++
    const p = playbackRef.current
    if (stationId && p.playerState === "playing") p.togglePlayPause()
    staticBurst(0.25)
    p.setDuck(1)
    setStationId(null)
    setStatus("off")
    stationIdsRef.current = new Set()
    liveSeekRef.current = null
  }, [stationId, staticBurst])

  /** Stops following the station but lets the current song play on (GTA mode switched off). */
  const release = useCallback(() => {
    epochRef.current++
    playbackRef.current.setDuck(1)
    setStationId(null)
    setStatus("off")
    stationIdsRef.current = new Set()
    liveSeekRef.current = null
  }, [])

  // "On air": the first song after tuning starts part-way through, once its length is known.
  const { currentTrack, duration } = playback
  useEffect(() => {
    const id = liveSeekRef.current
    if (!id || currentTrack?.videoId !== id || !(duration > 0)) return
    liveSeekRef.current = null
    if (duration > 60) playbackRef.current.seekTo(duration * (0.12 + Math.random() * 0.4))
    unduck(350)
  }, [currentTrack?.videoId, duration, unduck])

  // A short static crackle between songs while the radio is on.
  const prevTrackRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const id = currentTrack?.videoId
    const prev = prevTrackRef.current
    prevTrackRef.current = id
    if (status === "on" && id && stationIdsRef.current.has(id)) playedRef.current.add(id)
    if (status !== "on" || !id || !prev || id === prev) return
    if (stationIdsRef.current.has(id) && id !== liveSeekRef.current) staticBurst(0.2)
  }, [currentTrack?.videoId, status, staticBurst])

  // Leave the radio when something else takes over: the playing song isn't the station's
  // and none of its songs are waiting (choosing another song dropped them).
  const upcoming = playback.session.upcoming
  useEffect(() => {
    if (status !== "on") return
    // Forget station songs that have left the queue, so picking one of them again later
    // (from search, say) is the listener's own choice and not the station.
    const inQueue = new Set(upcoming.map((t) => t.videoId))
    if (currentTrack) inQueue.add(currentTrack.videoId)
    const ids = (stationIdsRef.current = new Set([...stationIdsRef.current].filter((id) => inQueue.has(id))))
    const playingStation = !!currentTrack && ids.has(currentTrack.videoId)
    if (playingStation || upcoming.some((t) => ids.has(t.videoId))) return
    epochRef.current++
    setStationId(null)
    setStatus("off")
    playbackRef.current.setDuck(1)
  }, [status, currentTrack, upcoming])

  // Keep the station's songs coming.
  const waiting = useMemo(
    () => upcoming.filter((t) => stationIdsRef.current.has(t.videoId) && !playedRef.current.has(t.videoId)).length,
    // currentTrack: a song moving from upcoming to playing changes what counts as played.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [upcoming, currentTrack?.videoId],
  )
  useEffect(() => {
    if (status !== "on" || !station || waiting >= KEEP_AHEAD) return
    const epoch = epochRef.current
    if (refillEpochRef.current === epoch) return
    refillEpochRef.current = epoch
    void nextSongs(station, KEEP_AHEAD - waiting, epoch)
      .then((tracks) => {
        if (epochRef.current !== epoch || tracks.length === 0) return
        tracks.forEach((t) => stationIdsRef.current.add(t.videoId))
        playbackRef.current.appendStationTracks(tracks)
      })
      .finally(() => {
        if (refillEpochRef.current === epoch) refillEpochRef.current = null
        // A newer station may have skipped its refill while this one was in flight.
        if (epochRef.current !== epoch) setRefillTick((t) => t + 1)
      })
  }, [status, station, waiting, nextSongs, refillTick])

  // The radio owns the queue while it's on: no related-song recommendations.
  useEffect(() => {
    playbackRef.current.suspendAutoplay(status !== "off")
  }, [status])

  useEffect(
    () => () => {
      if (unduckTimerRef.current) window.clearTimeout(unduckTimerRef.current)
    },
    [],
  )

  return { station, stationId, status, lastStationId, tune, off, release }
}

export type RadioController = ReturnType<typeof useRadio>
