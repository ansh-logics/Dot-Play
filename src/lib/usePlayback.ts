import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPlaybackClock } from "./playbackClock";
import type { DeckError, DeckSlot, PlaybackDeck, PlaybackState } from "./engine/deck";
import { getAutoplayTracks, recordPlayback, type SearchResult } from "./search";
import { cacheTrack, cacheTracks } from "./trackCache";
import {
  addToUpcoming,
  advanceOnTrackEnd,
  appendTracksToUpcoming,
  clearUpcoming,
  cycleTrackToEnd,
  DEFAULT_QUEUE_SESSION,
  loadPersistedSession,
  persistQueueSession,
  playNextUpcoming,
  playTrackImmediate,
  removeUpcoming,
  shuffleUpcoming,
  unshuffleUpcoming,
  type QueueSession,
} from "./queueManager";
import {
  loadPlaybackModes,
  loadVolume,
  nextRepeatMode,
  savePlaybackModes,
  saveVolume,
  type PlaybackModes,
} from "./playbackModes";
import { useSystemMediaControls } from "./useSystemMediaControls";
import { useDiscordPresence } from "./discordPresence";
import { useScrobbler } from "./scrobble";
import {
  loadPlaybackRate,
  normalizeRate,
  savePlaybackRate,
  sleepAfter,
  sleepFadeGain,
  sleepRemainingMs,
  type SleepTimer,
} from "./playbackExtras";
import {
  crossfadeStep,
  crossfadeVolumes,
  FADE_STEP_MS,
  fadeProgress,
  fadeSpan,
  HANDOFF_AT,
  HANDOFF_GUARD_S,
  secondsLeft,
  useCrossfadeSeconds,
} from "./crossfade";
import { useTrayBridge } from "./useTrayBridge";
import { useImmersiveBridge } from "./useImmersiveBridge";
import { usePlayerSkin } from "./usePlayerSkin";

/** Songs skipped in a row before giving up, so a queue of only blocked songs doesn't spin. */
const MAX_SKIPS_IN_A_ROW = 5;

/** Seconds of playback before a song counts as played in YouTube Music history. */
const RECORD_AFTER_SECONDS = 10;

/** A crossfade from the song playing to the next, on the idle player (`slot`). */
interface CrossfadeTransition {
  /** "arming": the next song is loading silently; "fading": both are playing. */
  phase: "arming" | "fading";
  slot: 0 | 1;
  /** The song fading out, and the one coming in. */
  after: string;
  nextTrack: SearchResult;
  /** The incoming song is buffered at its start, paused, ready to sound at once. */
  ready: boolean;
  /** The incoming song has become the current one (halfway through the fade). */
  handedOff: boolean;
  seconds: number;
  timer?: number;
}

interface PlaybackOptions {
  showToast: (message: string) => void;
  /** Called once per song when it is recorded to YouTube Music history. */
  onPlaybackRecorded: (track: SearchResult) => void;
  /** Tracks of the open playlist; Next falls back to them when the queue is empty. */
  playlistTracks: SearchResult[] | undefined;
  /** Liking from the menu bar popover goes through the app's own like action. */
  canLike: boolean;
  onToggleLike: (track: SearchResult) => void;
}

/**
 * The queue session and the hidden YouTube player: everything that decides what plays.
 * React state is the source of truth; the refs mirror it for callbacks that must not
 * be recreated on every progress tick.
 */
export function usePlayback({ showToast, onPlaybackRecorded, playlistTracks, canLike, onToggleLike }: PlaybackOptions) {
  const [session, setSession] = useState<QueueSession>(DEFAULT_QUEUE_SESSION);
  const sessionRef = useRef<QueueSession>(DEFAULT_QUEUE_SESSION);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const [initialPlaybackSeconds, setInitialPlaybackSeconds] = useState(0);
  const [autoPlayOnMount, setAutoPlayOnMount] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [playerState, setPlayerState] = useState<PlaybackState>("unstarted");
  // The position lives outside React state so App doesn't re-render 10 times a second.
  const [clock] = useState(createPlaybackClock);
  const [duration, setDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(loadVolume);
  const [playbackModes, setPlaybackModes] = useState<PlaybackModes>(loadPlaybackModes);
  /** Playback speed (1 = normal). */
  const [playbackRate, setPlaybackRate] = useState(loadPlaybackRate);
  const playbackRateRef = useRef(playbackRate);
  const [sleepTimer, setSleepTimerState] = useState<SleepTimer>(null);
  const sleepTimerRef = useRef<SleepTimer>(null);

  const playerRef = useRef<PlaybackDeck | null>(null);
  const isScrubbingRef = useRef(false);
  // Same value as the clock, under the name the callbacks below already use.
  const currentTimeRef = useMemo(() => ({ get current() { return clock.get(); } }), [clock]);
  const setCurrentTime = clock.set;
  const durationRef = useRef(0);
  const playerStateRef = useRef<PlaybackState>("unstarted");
  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);
  const playbackModesRef = useRef(playbackModes);
  const preShuffleOrderRef = useRef<SearchResult[] | null>(null);
  const recordedTrackIdRef = useRef<string | null>(null);
  const shouldAutoPlayRef = useRef(false);
  const queueFilledForRef = useRef<string | null>(null);

  // Crossfade (crossfade.ts has the rules): two hidden players. The active one is playerRef and
  // drives everything on screen; the other buffers the next song, then the two swap roles.
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const activeSlotRef = useRef<0 | 1>(0);
  const slotPlayersRef = useRef<[PlaybackDeck | null, PlaybackDeck | null]>([null, null]);
  /** The song the idle slot has loaded, so its videoId prop matches it (and nothing reloads). */
  const [standbyVideoIds, setStandbyVideoIds] = useState<[string | undefined, string | undefined]>([undefined, undefined]);
  const transitionRef = useRef<CrossfadeTransition | null>(null);
  /** A song whose next one failed to load on the idle player: it plays out normally. */
  const noFadeAfterRef = useRef<string | null>(null);
  /**
   * Stops a transition: the idle player is silenced and paused, and the active one goes back to
   * full volume. Before the halfway handover that keeps the song that was playing; after it, the
   * new one.
   */
  const cancelCrossfade = useCallback(() => {
    const transition = transitionRef.current;
    if (!transition) return;
    transitionRef.current = null;
    if (transition.timer) window.clearInterval(transition.timer);
    const idle = slotPlayersRef.current[activeSlotRef.current === 0 ? 1 : 0];
    idle?.pause();
    idle?.setVolume(0);
    playerRef.current?.setVolume(volumeRef.current);
  }, []);

  // Latest values for callbacks that are handed to memoized children and native bridges.
  const onPlaybackRecordedRef = useRef(onPlaybackRecorded);
  const playlistTracksRef = useRef(playlistTracks);
  useEffect(() => {
    onPlaybackRecordedRef.current = onPlaybackRecorded;
    playlistTracksRef.current = playlistTracks;
  });

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    playerStateRef.current = playerState;
  }, [playerState]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    playbackModesRef.current = playbackModes;
    savePlaybackModes(playbackModes);
  }, [playbackModes]);

  /**
   * Applies a queue change and persists it; every queue edit goes through here. The update
   * runs once against the latest session (not inside a state updater, which React may run
   * twice), so updates are free to show toasts or start playback.
   */
  const commitSession = useCallback((update: (prev: QueueSession) => QueueSession) => {
    const prev = sessionRef.current;
    const next = update(prev);
    if (next === prev) return;
    sessionRef.current = next;
    setSession(next);
    void persistQueueSession(next);
  }, []);

  const persistCurrentPosition = useCallback((seconds: number) => {
    void persistQueueSession({ ...sessionRef.current, currentTime: seconds });
  }, []);

  // Restore the saved session on startup. It stays paused: never autoplay after launch.
  useEffect(() => {
    let cancelled = false;
    void loadPersistedSession().then((restored) => {
      if (cancelled) return;
      setSession(restored);
      sessionRef.current = restored;
      // The restored song was already counted when it played; don't record it again.
      recordedTrackIdRef.current = restored.currentTrack?.videoId ?? null;
      if (restored.currentTrack) {
        setInitialPlaybackSeconds(restored.currentTime);
        setCurrentTime(restored.currentTime);
        setAutoPlayOnMount(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Best-effort save when the window closes or reloads.
  useEffect(() => {
    const handleBeforeUnload = () => {
      void persistQueueSession({ ...sessionRef.current, currentTime: currentTimeRef.current });
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const currentTrack = session.currentTrack;

  // With Autoplay on, fill an empty upcoming queue with 10 recommendations for the current
  // song. Once per song: a queue the user clears stays empty.
  useEffect(() => {
    const sourceVideoId = currentTrack?.videoId;
    if (!sourceVideoId || !playbackModes.autoplay) return;
    if (session.upcoming.length > 0) return;
    if (queueFilledForRef.current === sourceVideoId) return;
    queueFilledForRef.current = sourceVideoId;

    let isCancelled = false;
    void getAutoplayTracks(sessionRef.current, 10)
      .then((tracks) => {
        if (isCancelled || tracks.length === 0) return;
        cacheTracks(tracks);
        commitSession((prev) =>
          prev.currentTrack?.videoId !== sourceVideoId || prev.upcoming.length > 0
            ? prev
            : { ...prev, upcoming: tracks, isAutoplay: false },
        );
      })
      .catch((err) => {
        console.warn("[DOT Music] Failed to fetch queue recommendations:", err);
      });

    return () => {
      isCancelled = true;
    };
  }, [currentTrack?.videoId, session.upcoming.length, playbackModes.autoplay, commitSession]);

  // Queue operations
  const handleUpcomingReorder = useCallback(
    (upcoming: SearchResult[]) => {
      commitSession((prev) => {
        const isUnchanged =
          prev.upcoming.length === upcoming.length &&
          prev.upcoming.every((track, index) => track.videoId === upcoming[index]?.videoId);
        return isUnchanged ? prev : { ...prev, upcoming };
      });
    },
    [commitSession],
  );

  const handleRemoveUpcoming = useCallback(
    (indexToRemove: number) => commitSession((prev) => removeUpcoming(prev, indexToRemove)),
    [commitSession],
  );

  /** Removes by song, re-finding its position: the queue may have moved since the UI drew it. */
  const removeUpcomingTrack = useCallback(
    (index: number, videoId: string) =>
      commitSession((prev) => {
        const at =
          prev.upcoming[index]?.videoId === videoId
            ? index
            : prev.upcoming.findIndex((t) => t.videoId === videoId);
        return at >= 0 ? removeUpcoming(prev, at) : prev;
      }),
    [commitSession],
  );

  const handleClearUpcoming = useCallback(
    () => commitSession((prev) => clearUpcoming(prev)),
    [commitSession],
  );

  const handleAddToQueue = useCallback(
    (track: SearchResult) => {
      if (!track.videoId) return;
      commitSession((prev) => {
        const { session: next, added } = addToUpcoming(prev, track);
        if (!added) {
          showToast("Already in your upcoming queue.");
          return prev;
        }
        return next;
      });
    },
    [commitSession, showToast],
  );

  const handleAppendTracksToQueue = useCallback(
    (tracks: SearchResult[]) => {
      if (!tracks || tracks.length === 0) return;
      commitSession((prev) => appendTracksToUpcoming(prev, tracks));
    },
    [commitSession],
  );

  // Playback modes
  const cycleRepeatMode = useCallback(() => {
    setPlaybackModes((m) => ({ ...m, repeat: nextRepeatMode(m.repeat) }));
  }, []);

  const toggleAutoplay = useCallback(() => {
    const turningOn = !playbackModesRef.current.autoplay;
    setPlaybackModes((m) => ({ ...m, autoplay: turningOn }));
    // The ∞ icon alone doesn't say what it does; the toast does.
    showToast(turningOn ? "Autoplay on: similar songs keep playing after your queue." : "Autoplay off: playback stops when your queue ends.");
  }, [showToast]);

  const toggleShuffle = useCallback(() => {
    const turningOn = !playbackModesRef.current.shuffle;
    commitSession((prev) => {
      if (turningOn) {
        const shuffled = shuffleUpcoming(prev);
        preShuffleOrderRef.current = shuffled.originalOrder;
        return shuffled.session;
      }
      const original = preShuffleOrderRef.current ?? prev.upcoming;
      preShuffleOrderRef.current = null;
      return unshuffleUpcoming(prev, original);
    });
    setPlaybackModes((m) => ({ ...m, shuffle: turningOn }));
  }, [commitSession]);

  // Volume
  const changeVolume = useCallback((next: number) => {
    // Commands from the menu bar or a phone arrive untyped; ignore anything that isn't a number.
    if (!Number.isFinite(next)) return;
    const v = Math.max(0, Math.min(100, Math.round(next)));
    setVolume(v);
    volumeRef.current = v;
    playerRef.current?.setVolume(v);
    if (v === 0 && !isMutedRef.current) {
      playerRef.current?.setMuted(true);
      setIsMuted(true);
    } else if (v > 0 && isMutedRef.current) {
      playerRef.current?.setMuted(false);
      setIsMuted(false);
    }
    if (v > 0) saveVolume(v);
  }, []);

  const toggleMute = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    // Mid-fade both songs are audible, so both follow the mute.
    const fading = transitionRef.current?.phase === "fading";
    const idle = fading ? slotPlayersRef.current[activeSlotRef.current === 0 ? 1 : 0] : null;
    if (isMutedRef.current) {
      player.setMuted(false);
      idle?.setMuted(false);
      setIsMuted(false);
      if (volumeRef.current === 0) {
        setVolume(100);
        volumeRef.current = 100;
        player.setVolume(100);
      }
    } else {
      player.setMuted(true);
      idle?.setMuted(true);
      setIsMuted(true);
    }
  }, []);

  // Speed
  const changePlaybackRate = useCallback((next: number) => {
    const rate = normalizeRate(next);
    playbackRateRef.current = rate;
    setPlaybackRate(rate);
    savePlaybackRate(rate);
    playerRef.current?.setRate(rate);
  }, []);

  // Sleep timer
  const setSleepTimer = useCallback(
    (timer: SleepTimer) => {
      sleepTimerRef.current = timer;
      setSleepTimerState(timer);
      if (!timer) showToast("Sleep timer off.");
      else if (timer.kind === "endOfTrack") showToast("Playback will stop when this song ends.");
      else showToast(`Playback will stop in ${timer.minutes} minutes.`);
    },
    [showToast],
  );
  const startSleepTimer = useCallback((minutes: number) => setSleepTimer(sleepAfter(minutes)), [setSleepTimer]);
  const sleepAtEndOfTrack = useCallback(() => setSleepTimer({ kind: "endOfTrack" }), [setSleepTimer]);
  const cancelSleepTimer = useCallback(() => setSleepTimer(null), [setSleepTimer]);

  // Transport
  const seekTo = useCallback(
    (seconds: number) => {
      if (!playerRef.current) return;
      cancelCrossfade();
      const total = durationRef.current;
      const target = Math.max(0, Math.min(total > 0 ? total : seconds, seconds));
      playerRef.current.seek(target);
      setCurrentTime(target);
      persistCurrentPosition(target);
    },
    [persistCurrentPosition, cancelCrossfade],
  );

  const seekRelative = useCallback(
    (deltaSeconds: number) => {
      if (!playerRef.current || !isPlayerReady) return;
      cancelCrossfade();
      const total = durationRef.current;
      const target = Math.max(
        0,
        Math.min(total > 0 ? total : 999999, currentTimeRef.current + deltaSeconds),
      );
      playerRef.current.seek(target);
      setCurrentTime(target);
      persistCurrentPosition(target);
    },
    [isPlayerReady, persistCurrentPosition, cancelCrossfade],
  );

  const togglePlayPause = useCallback(() => {
    if (!playerRef.current || !isPlayerReady) return;
    cancelCrossfade();
    if (playerStateRef.current === "playing") {
      playerRef.current.pause();
      persistCurrentPosition(currentTimeRef.current);
    } else {
      if (playerStateRef.current === "ended") {
        playerRef.current.seek(0);
        setCurrentTime(0);
      }
      playerRef.current.play();
    }
  }, [isPlayerReady, persistCurrentPosition, cancelCrossfade]);

  /** Scrubber drag: the slider moves freely and the player seeks once on release. */
  const beginScrub = useCallback(() => {
    isScrubbingRef.current = true;
  }, []);

  const scrubTo = useCallback((seconds: number) => {
    setCurrentTime(seconds);
    if (!isScrubbingRef.current) {
      cancelCrossfade();
      playerRef.current?.seek(seconds);
    }
  }, [cancelCrossfade]);

  const endScrub = useCallback(
    (seconds: number) => {
      isScrubbingRef.current = false;
      cancelCrossfade();
      playerRef.current?.seek(seconds);
      persistCurrentPosition(seconds);
    },
    [persistCurrentPosition, cancelCrossfade],
  );

  const recordIfNeeded = useCallback((track: SearchResult | null) => {
    if (!track?.videoId || recordedTrackIdRef.current === track.videoId) return;
    recordedTrackIdRef.current = track.videoId;
    void recordPlayback(track.videoId, durationRef.current, currentTimeRef.current);
    onPlaybackRecordedRef.current(track);
  }, []);

  /** Loads a song into the player. Queue state is updated separately by the caller. */
  const playTrack = useCallback((track: SearchResult) => {
    if (!track || !track.videoId || !track.videoId.trim()) {
      console.warn("Attempted to play track without valid videoId:", track);
      return;
    }
    cancelCrossfade();
    recordedTrackIdRef.current = null;
    cacheTrack(track);
    setCurrentTime(0);
    setDuration(0);
    setPlaybackError(null);
    setPlayerState("buffering");

    playerRef.current?.load({ videoId: track.videoId }, { autoplay: true });
  }, [cancelCrossfade]);

  /** Plays a song and makes it current in the queue. */
  const startTrack = useCallback(
    (track: SearchResult, update: (prev: QueueSession) => QueueSession) => {
      setAutoPlayOnMount(true);
      playTrack(track);
      commitSession(update);
    },
    [commitSession, playTrack],
  );

  const handleSelectUpcoming = useCallback(
    (track: SearchResult) => {
      if (!track.videoId) return;
      startTrack(track, (prev) => playTrackImmediate(prev, track));
    },
    [startTrack],
  );

  const selectTrack = useCallback(
    (track: SearchResult, contextList?: SearchResult[]) => {
      startTrack(track, (prev) => {
        const next = playTrackImmediate(prev, track, {
          contextUpcoming: contextList,
          isAutoplay: false,
          keepUserQueuedOnly: true,
        });
        if (!playbackModesRef.current.shuffle || !contextList || contextList.length === 0) return next;
        // Shuffle stays on for the next playlist too. Songs the listener queued themselves
        // stay first; the playlist after them is shuffled, and turning shuffle off restores it.
        const userQueued = next.upcoming.findIndex((t) => t.queueSource !== "user");
        const shuffled = shuffleUpcoming(next, userQueued === -1 ? next.upcoming.length : userQueued);
        preShuffleOrderRef.current = shuffled.originalOrder;
        return shuffled.session;
      });
    },
    [startTrack],
  );

  const handlePlayNext = useCallback(
    (track: SearchResult) => {
      if (!track.videoId) return;
      commitSession((prev) => {
        const { session: next, added, playedImmediate } = playNextUpcoming(prev, track);
        if (!added) {
          showToast("Already in your upcoming queue.");
          return prev;
        }
        if (playedImmediate) {
          setAutoPlayOnMount(true);
          playTrack(track);
        }
        return next;
      });
    },
    [commitSession, showToast, playTrack],
  );

  /**
   * Fetches recommendations and plays the first. Returns "played", "none" (nothing came
   * back) or "stale": while it waited the user picked another song or queued some, and
   * their choice wins.
   */
  const playAutoplayFrom = useCallback(
    async (
      seed: QueueSession,
      apply: (prev: QueueSession, first: SearchResult, rest: SearchResult[]) => QueueSession,
    ): Promise<"played" | "none" | "stale"> => {
      const playingBefore = sessionRef.current.currentTrack?.videoId;
      const recs = await getAutoplayTracks(seed, 10);
      const now = sessionRef.current;
      if (now.currentTrack?.videoId !== playingBefore || now.upcoming.length > 0) return "stale";
      if (recs.length === 0) return "none";
      const [nextPlay, ...remaining] = recs;
      cacheTracks(recs);
      startTrack(nextPlay, (prev) => apply(prev, nextPlay, remaining));
      return "played";
    },
    [startTrack],
  );

  // Latest versions, for the player callback and for retrying after a stale autoplay fetch.
  const handleTrackCompletedRef = useRef<() => Promise<void>>(async () => {});
  const handleNextTrackRef = useRef<() => Promise<void>>(async () => {});

  const handleTrackCompleted = useCallback(async () => {
    const current = sessionRef.current;
    const { repeat, autoplay } = playbackModesRef.current;

    // "Stop after this song": move on to the next song, but leave it waiting, paused.
    if (sleepTimerRef.current?.kind === "endOfTrack") {
      sleepTimerRef.current = null;
      setSleepTimerState(null);
      const { session: nextSession, nextTrack } = advanceOnTrackEnd(current, { repeat: repeat === "one" ? "off" : repeat });
      if (nextTrack?.videoId) {
        recordedTrackIdRef.current = null;
        cacheTrack(nextTrack);
        setAutoPlayOnMount(false);
        setCurrentTime(0);
        setDuration(0);
        setPlayerState("paused");
        playerRef.current?.load({ videoId: nextTrack.videoId }, { autoplay: false });
      }
      commitSession(() => nextSession);
      showToast("Sleep timer: stopped after the song.");
      return;
    }

    if (repeat === "one" && current.currentTrack && playerRef.current) {
      playerRef.current.seek(0);
      setCurrentTime(0);
      playerRef.current.play();
      return;
    }

    const { session: nextSession, nextTrack, needsAutoplay } = advanceOnTrackEnd(current, { repeat });

    if (nextTrack) {
      startTrack(nextTrack, () => nextSession);
      return;
    }

    if (!needsAutoplay) return;
    if (autoplay && current.currentTrack?.videoId) {
      try {
        // nextSession already has the finished song in history, so it's excluded and seeds the radio.
        const result = await playAutoplayFrom(nextSession, (_prev, first, rest) => ({
          ...nextSession,
          currentTrack: first,
          upcoming: rest,
          currentTime: 0,
          isAutoplay: false,
        }));
        if (result === "played") return;
        if (result === "stale") {
          // Songs were queued while waiting: continue with them; a picked song just plays on.
          if (sessionRef.current.currentTrack?.videoId === current.currentTrack.videoId) {
            void handleTrackCompletedRef.current();
          }
          return;
        }
      } catch (e) {
        console.warn("[DOT Music] Autoplay recommendation failed:", e);
      }
    }
    commitSession(() => nextSession);
  }, [showToast, commitSession, playAutoplayFrom, startTrack]);

  const handleNextTrack = useCallback(async () => {
    const current = sessionRef.current;
    const { repeat, autoplay } = playbackModesRef.current;
    const upcoming =
      repeat === "all" ? cycleTrackToEnd(current.upcoming, current.currentTrack) : current.upcoming;
    if (upcoming.length > 0) {
      const nextTrack = upcoming[0];
      startTrack(nextTrack, (prev) => {
        const cycled =
          repeat === "all" ? cycleTrackToEnd(prev.upcoming, prev.currentTrack) : prev.upcoming;
        return playTrackImmediate({ ...prev, upcoming: cycled }, nextTrack);
      });
      return;
    }

    if (autoplay && current.currentTrack?.videoId) {
      try {
        const result = await playAutoplayFrom(current, (prev, first, rest) => ({
          ...playTrackImmediate(prev, first),
          upcoming: rest,
          isAutoplay: false,
        }));
        if (result === "played") return;
        if (result === "stale") {
          if (sessionRef.current.currentTrack?.videoId === current.currentTrack.videoId) {
            void handleNextTrackRef.current();
          }
          return;
        }
      } catch (e) {
        console.warn("[DOT Music] Failed to fetch next track recommendation:", e);
      }
    }

    const tracks = playlistTracksRef.current;
    if (tracks && tracks.length > 0 && current.currentTrack) {
      const idx = tracks.findIndex((t) => t.videoId === current.currentTrack?.videoId);
      if (idx !== -1 && idx < tracks.length - 1) {
        const nextTrack = tracks[idx + 1];
        startTrack(nextTrack, (prev) => playTrackImmediate(prev, nextTrack));
      }
    }
  }, [playAutoplayFrom, startTrack]);

  const handlePreviousTrack = useCallback(() => {
    if (currentTimeRef.current > 3) {
      playerRef.current?.seek(0);
      setCurrentTime(0);
      return;
    }

    const { history } = sessionRef.current;
    if (history.length > 0) {
      const prevTrack = history[history.length - 1];
      startTrack(prevTrack, (prev) => playTrackImmediate(prev, prevTrack));
      return;
    }

    playerRef.current?.seek(0);
    setCurrentTime(0);
  }, [startTrack]);

  // Hidden player callbacks
  useEffect(() => {
    handleTrackCompletedRef.current = handleTrackCompleted;
    handleNextTrackRef.current = handleNextTrack;
  }, [handleTrackCompleted, handleNextTrack]);

  const handlePlayerReady = useCallback((player: PlaybackDeck) => {
    playerRef.current = player;
    setIsPlayerReady(true);
    player.setVolume(volumeRef.current);
    if (playbackRateRef.current !== 1) player.setRate(playbackRateRef.current);
    const initialDuration = player.duration();
    if (initialDuration > 0) {
      setDuration(initialDuration);
    }
    if (shouldAutoPlayRef.current) {
      player.play();
      shouldAutoPlayRef.current = false;
    }
  }, []);

  const skipsInARowRef = useRef(0);
  /** Set below: true when an "ended" was taken by a crossfade's handover. */
  const crossfadeEndedRef = useRef<() => boolean>(() => false);
  const handlePlayerStateChange = useCallback(
    (state: PlaybackState) => {
      setPlayerState(state);
      if (state === "playing") {
        skipsInARowRef.current = 0;
        setPlaybackError(null);
        // YouTube resets the speed when it loads a song; put the chosen one back.
        if (playbackRateRef.current !== 1) playerRef.current?.setRate(playbackRateRef.current);
      } else if (state === "ended") {
        // Mid-crossfade the next song is already playing: it takes over now.
        if (crossfadeEndedRef.current()) return;
        recordIfNeeded(sessionRef.current.currentTrack);
        void handleTrackCompletedRef.current();
      }
    },
    [recordIfNeeded],
  );

  const handlePlayerError = useCallback(
    (error: DeckError) => {
      setPlayerState("paused");
      setPlaybackError(error.message);
      if (error.unplayable && skipsInARowRef.current < MAX_SKIPS_IN_A_ROW) {
        skipsInARowRef.current += 1;
        const title = sessionRef.current.currentTrack?.title;
        showToast(title ? `Skipped “${title}”: it can't be played here.` : "Skipped a song that can't be played here.");
        void handleNextTrackRef.current();
      }
    },
    [showToast],
  );

  // The player only fills in a missing title or artist; the React queue decides what plays.
  const handleTrackChangeFromIframe = useCallback(
    (info: { videoId: string; title?: string; artist?: string }) => {
      if (!info.videoId) return;
      commitSession((prev) => {
        if (!prev.currentTrack || prev.currentTrack.videoId !== info.videoId) return prev;
        if (prev.currentTrack.title || !info.title) return prev;
        return {
          ...prev,
          currentTrack: {
            ...prev.currentTrack,
            title: info.title || prev.currentTrack.title,
            artist: info.artist || prev.currentTrack.artist,
          },
        };
      });
    },
    [commitSession],
  );

  /** Loads the next song on the idle player, muted, and starts it so it buffers (rule 1). */
  const bufferNext = useCallback((player: PlaybackDeck, videoId: string) => {
    player.setMuted(true);
    player.setVolume(0);
    player.load({ videoId }, { autoplay: true });
  }, []);

  /** The idle player's events: they only matter while it's getting the next song ready. */
  const onIdleState = useCallback((slot: 0 | 1, state: PlaybackState, player: PlaybackDeck | null) => {
    const transition = transitionRef.current;
    if (!transition || transition.slot !== slot || transition.phase !== "arming" || transition.ready) return;
    if (state === "playing" && player) {
      // It has started, so its start is buffered: park it there until the fade.
      player.pause();
      player.seek(0);
      transition.ready = true;
    }
  }, []);

  const onIdleError = useCallback(
    (slot: 0 | 1) => {
      const transition = transitionRef.current;
      if (!transition || transition.slot !== slot || transition.handedOff) return;
      // The next song can't play here: let this one end normally (the usual skip follows).
      noFadeAfterRef.current = transition.after;
      cancelCrossfade();
    },
    [cancelCrossfade],
  );

  // Each hidden player reports to the playback handlers only while it's the active one.
  const slotHandlers = useMemo(
    () =>
      ([0, 1] as const).map((slot) => ({
        onReady: (player: PlaybackDeck) => {
          slotPlayersRef.current[slot] = player;
          if (slot === activeSlotRef.current) {
            handlePlayerReady(player);
            return;
          }
          player.setMuted(true);
          player.setVolume(0);
          // Created for a transition: start buffering once the player has cued its prop
          // (it does that straight after this callback).
          const transition = transitionRef.current;
          if (transition?.slot === slot && transition.phase === "arming") {
            window.setTimeout(() => {
              if (transitionRef.current === transition) bufferNext(player, transition.nextTrack.videoId!);
            }, 0);
          }
        },
        onStateChange: (state: PlaybackState) => {
          if (slot === activeSlotRef.current) handlePlayerStateChange(state);
          else onIdleState(slot, state, slotPlayersRef.current[slot]);
        },
        onError: (error: DeckError) => {
          if (slot === activeSlotRef.current) handlePlayerError(error);
          else onIdleError(slot);
        },
        onTrackInfo: (info: { videoId: string; title?: string; artist?: string }) => {
          if (slot === activeSlotRef.current) handleTrackChangeFromIframe(info);
        },
      })),
    [handlePlayerReady, handlePlayerStateChange, handlePlayerError, handleTrackChangeFromIframe, bufferNext, onIdleState, onIdleError],
  );

  /**
   * Halfway through the fade (rule 4): the incoming song becomes the current one, and the
   * player it's on becomes the one the clock, controls and events follow.
   */
  const handOff = useCallback(
    (transition: CrossfadeTransition) => {
      if (transition.handedOff) return;
      const incoming = slotPlayersRef.current[transition.slot];
      if (!incoming) return;
      transition.handedOff = true;
      const { nextTrack } = transition;
      recordIfNeeded(sessionRef.current.currentTrack);

      const outgoingSlot = activeSlotRef.current;
      activeSlotRef.current = transition.slot;
      setActiveSlot(transition.slot);
      playerRef.current = incoming;
      // The outgoing player keeps the song it's playing as its prop, so it never reloads one.
      setStandbyVideoIds((ids) => (outgoingSlot === 0 ? [transition.after, ids[1]] : [ids[0], transition.after]));

      recordedTrackIdRef.current = null;
      cacheTrack(nextTrack);
      setCurrentTime(incoming.position() || 0);
      setDuration(incoming.duration() || 0);
      setPlaybackError(null);
      setPlayerState("playing");
      setAutoPlayOnMount(true);
      const { repeat } = playbackModesRef.current;
      const advanced = advanceOnTrackEnd(sessionRef.current, { repeat });
      // The queue was edited mid-fade so the next song isn't the one fading in: it still
      // becomes the current song.
      commitSession(() =>
        advanced.nextTrack?.videoId === nextTrack.videoId
          ? advanced.session
          : playTrackImmediate(sessionRef.current, nextTrack),
      );
    },
    [commitSession, recordIfNeeded, setCurrentTime],
  );

  /** The next song is ready and the current one has reached its fade: start the blend (rules 2, 3). */
  const startFade = useCallback(
    (transition: CrossfadeTransition) => {
      const outgoing = playerRef.current;
      const incoming = slotPlayersRef.current[transition.slot];
      if (!outgoing || !incoming || outgoing === incoming) return;

      incoming.setVolume(0);
      incoming.setMuted(isMutedRef.current);
      if (playbackRateRef.current !== 1) incoming.setRate(playbackRateRef.current);
      incoming.play();
      transition.phase = "fading";

      const tick = () => {
        if (transitionRef.current !== transition) return;
        const rate = playbackRateRef.current;
        const span = fadeSpan(transition.seconds, incoming.duration() / (rate > 0 ? rate : 1));
        const progress = fadeProgress({
          incomingPlayed: incoming.position() / (rate > 0 ? rate : 1),
          outgoingLeft: secondsLeft(outgoing.position(), outgoing.duration(), rate),
          span,
        });
        const volumes = crossfadeVolumes(progress, volumeRef.current);
        outgoing.setVolume(volumes.outgoing);
        incoming.setVolume(volumes.incoming);

        const outgoingLeft = secondsLeft(outgoing.position(), outgoing.duration(), rate);
        if (!transition.handedOff && (progress >= HANDOFF_AT || outgoingLeft <= HANDOFF_GUARD_S)) {
          handOff(transition);
        }
        if (progress >= 1) {
          handOff(transition);
          window.clearInterval(transition.timer);
          transitionRef.current = null;
          outgoing.pause();
          outgoing.setVolume(0);
          incoming.setVolume(volumeRef.current);
        }
      };
      transition.timer = window.setInterval(tick, FADE_STEP_MS);
    },
    [handOff],
  );

  // The outgoing song ending by itself before the handover: the incoming one takes over now.
  useEffect(() => {
    crossfadeEndedRef.current = () => {
      const transition = transitionRef.current;
      if (transition?.phase !== "fading" || transition.handedOff) return false;
      handOff(transition);
      return true;
    };
  }, [handOff]);

  // Near the end of a song: get the next one ready on the idle player, then fade into it once
  // it is. Left to play out normally with repeat-one, "stop after this song", or when the next
  // song isn't known yet (autoplay still to fetch).
  const crossfadeSeconds = useCrossfadeSeconds();
  useEffect(() => {
    const currentId = currentTrack?.videoId;
    if (crossfadeSeconds === 0 || playerState !== "playing" || !currentId) return;
    const check = () => {
      const transition = transitionRef.current;
      if (transition?.phase === "fading" || isScrubbingRef.current) return;
      const step = crossfadeStep({
        fade: crossfadeSeconds,
        position: clock.get(),
        duration: durationRef.current,
        rate: playbackRateRef.current,
      });
      if (step === "wait" || noFadeAfterRef.current === currentId) return;
      const { repeat } = playbackModesRef.current;
      if (repeat === "one" || sleepTimerRef.current?.kind === "endOfTrack") return;
      // The sleep timer is about to fade playback out: no new song fading in over that.
      const sleepLeft = sleepTimerRef.current ? sleepRemainingMs(sleepTimerRef.current) : null;
      if (sleepLeft !== null && sleepLeft < 60_000) return;
      const { nextTrack } = advanceOnTrackEnd(sessionRef.current, { repeat });
      const nextId = nextTrack?.videoId;
      if (!nextTrack || !nextId || nextId === currentId) return;

      if (transition?.after !== currentId || transition.nextTrack.videoId !== nextId) {
        cancelCrossfade();
        const slot: 0 | 1 = activeSlotRef.current === 0 ? 1 : 0;
        const armed: CrossfadeTransition = {
          phase: "arming",
          slot,
          after: currentId,
          nextTrack,
          ready: false,
          handedOff: false,
          seconds: crossfadeSeconds,
        };
        transitionRef.current = armed;
        const player = slotPlayersRef.current[slot];
        if (player) bufferNext(player, nextId);
        // Creates the idle player the first time (onReady then buffers), or just matches its
        // prop to what it was told to load.
        setStandbyVideoIds((ids) => (slot === 0 ? [nextId, ids[1]] : [ids[0], nextId]));
        return;
      }
      // Not ready yet at the fade point: keep waiting. If the song ends first it moves on as
      // it would without crossfade.
      if (step === "fade" && transition.ready) startFade(transition);
    };
    check();
    return clock.subscribe(check);
  }, [clock, crossfadeSeconds, currentTrack, playerState, startFade, cancelCrossfade, bufferNext]);

  // A new song (picked, skipped to, or faded into) is allowed a crossfade again.
  useEffect(() => {
    if (noFadeAfterRef.current && noFadeAfterRef.current !== currentTrack?.videoId) noFadeAfterRef.current = null;
  }, [currentTrack]);

  // A fade still running when the app closes this hook down.
  useEffect(() => () => cancelCrossfade(), [cancelCrossfade]);

  const deckSlots = ([0, 1] as const).map((slot): DeckSlot => {
    const videoId = slot === activeSlot ? currentTrack?.videoId : standbyVideoIds[slot];
    return {
      key: `deck-${slot}`,
      track: videoId ? { videoId } : undefined,
      initialSeconds: slot === activeSlot ? initialPlaybackSeconds : 0,
      autoplay: slot === activeSlot ? autoPlayOnMount : false,
      ...slotHandlers[slot],
    };
  });

  // Progress sync: 100 ms while playing keeps lyrics tight, 250 ms otherwise.
  useEffect(() => {
    if (!isPlayerReady || !currentTrack) return;

    const syncPlayerTime = () => {
      const player = playerRef.current;
      if (!player) return;
      if (!isScrubbingRef.current) {
        setCurrentTime(player.position());
      }
      const currentDuration = player.duration();
      if (currentDuration > 0) {
        setDuration(currentDuration);
      }
    };

    syncPlayerTime();
    const timer = window.setInterval(syncPlayerTime, playerState === "playing" ? 100 : 250);
    return () => window.clearInterval(timer);
  }, [isPlayerReady, currentTrack, playerState]);

  // Record the song once it has actually played long enough (not on a restored position).
  useEffect(() => {
    if (playerState !== "playing") return;
    const check = () => {
      if (clock.get() >= RECORD_AFTER_SECONDS) recordIfNeeded(currentTrack);
    };
    check();
    return clock.subscribe(check);
  }, [clock, currentTrack, playerState, recordIfNeeded]);

  // The timed sleep timer: fade out over the last seconds, then pause. A deadline on the wall
  // clock, checked often, so a sleeping Mac or a throttled window can't stretch it.
  useEffect(() => {
    if (sleepTimer?.kind !== "at") return;
    let fading = false;
    const restoreVolume = () => {
      if (!fading) return;
      fading = false;
      playerRef.current?.setVolume(volumeRef.current);
    };
    const tick = () => {
      const remaining = sleepRemainingMs(sleepTimer);
      if (remaining === null) return;
      const playing = playerStateRef.current === "playing" || playerStateRef.current === "buffering";
      if (remaining <= 0) {
        if (playing) {
          cancelCrossfade();
          playerRef.current?.pause();
          persistCurrentPosition(currentTimeRef.current);
        }
        restoreVolume();
        sleepTimerRef.current = null;
        setSleepTimerState(null);
        if (playing) showToast("Sleep timer: playback paused.");
        return;
      }
      const gain = sleepFadeGain(remaining);
      if (gain < 1 && playing) {
        fading = true;
        playerRef.current?.setVolume(Math.round(volumeRef.current * gain));
      }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => {
      window.clearInterval(timer);
      restoreVolume();
    };
  }, [sleepTimer, persistCurrentPosition, currentTimeRef, showToast, cancelCrossfade]);

  useDiscordPresence({ track: currentTrack, playerState, clock, duration, rate: playbackRate });
  useScrobbler({ track: currentTrack, playerState, clock, duration });

  useSystemMediaControls({
    track: currentTrack,
    playerState,
    clock,
    duration,
    rate: playbackRate,
    onTogglePlayPause: togglePlayPause,
    onNext: handleNextTrack,
    onPrevious: handlePreviousTrack,
    onSeek: seekTo,
  });

  const skin = usePlayerSkin();
  useTrayBridge({
    upcoming: session.upcoming,
    playbackModes,
    skin,
    volume,
    isMuted,
    onSelectUpcoming: handleSelectUpcoming,
    onRemoveUpcoming: handleRemoveUpcoming,
    onReorderUpcoming: handleUpcomingReorder,
    onPlayTrack: selectTrack,
    onPlayNext: handlePlayNext,
    onAddToQueue: handleAddToQueue,
    onToggleShuffle: toggleShuffle,
    onCycleRepeat: cycleRepeatMode,
    onChangeVolume: changeVolume,
    onToggleMute: toggleMute,
    currentVideoId: currentTrack?.videoId,
    canLike,
    onToggleLike: () => {
      if (currentTrack) onToggleLike(currentTrack);
    },
  });
  useImmersiveBridge({ skin, upcoming: session.upcoming });

  /** Signing out drops the account's listening history from the local queue. */
  const clearSessionHistory = useCallback(
    () => commitSession((prev) => ({ ...prev, history: [] })),
    [commitSession],
  );

  return {
    session,
    currentTrack,
    initialPlaybackSeconds,
    autoPlayOnMount,
    isPlayerReady,
    playerState,
    /** Read with useCurrentTime / WithCurrentTime, or clock.get() in callbacks. */
    clock,
    duration,
    playbackError,
    volume,
    isMuted,
    playbackModes,
    // queue
    handleUpcomingReorder,
    handleRemoveUpcoming,
    removeUpcomingTrack,
    handleClearUpcoming,
    handleAddToQueue,
    handleAppendTracksToQueue,
    handleSelectUpcoming,
    selectTrack,
    handlePlayNext,
    clearSessionHistory,
    // transport
    togglePlayPause,
    seekTo,
    seekRelative,
    beginScrub,
    scrubTo,
    endScrub,
    handleNextTrack,
    handlePreviousTrack,
    changeVolume,
    toggleMute,
    cycleRepeatMode,
    toggleAutoplay,
    toggleShuffle,
    // speed and sleep
    playbackRate,
    changePlaybackRate,
    sleepTimer,
    startSleepTimer,
    sleepAtEndOfTrack,
    cancelSleepTimer,
    // playback decks (two, for crossfade)
    deckSlots,
  };
}
