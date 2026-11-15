import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPlaybackClock } from "./playbackClock";
import type {
  YouTubePlayerInstance,
  YouTubePlaybackState,
} from "../components/HiddenYouTubePlayer";
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
import { useTrayBridge } from "./useTrayBridge";
import { useImmersiveBridge } from "./useImmersiveBridge";
import { usePlayerSkin } from "./usePlayerSkin";
import { listen } from "@tauri-apps/api/event";
import { cleanDisplayTitle } from "./displayText";
import { optimizeThumbnailUrl } from "./imagePipeline";
import { isTauriEnvironment } from "./search";
import { createTvPlayer, type TvPlayer } from "./tvOutput";
import { getTvs, sendToTv } from "./tvs";

const PLAYER_ERROR_MESSAGES: Record<number, string> = {
  [-1]: "Could not load YouTube Player API.",
  2: "Invalid video track ID.",
  5: "YouTube HTML5 player error.",
  100: "Track is unavailable or private.",
  101: "Embedded playback blocked by track owner.",
  150: "Embedded playback blocked by track owner.",
  153: "Embedded player origin error.",
};

/** Errors that mean this song can never play here (removed, private, or not allowed in an
 *  embedded player); playback moves on to the next song instead of stopping. */
const UNPLAYABLE_ERRORS = new Set([2, 100, 101, 150, 153]);
/** Songs skipped in a row before giving up, so a queue of only blocked songs doesn't spin. */
const MAX_SKIPS_IN_A_ROW = 5;

/** Seconds of playback before a song counts as played in YouTube Music history. */
const RECORD_AFTER_SECONDS = 10;

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
  const [playerState, setPlayerState] = useState<YouTubePlaybackState>("unstarted");
  // The position lives outside React state so App doesn't re-render 10 times a second.
  const [clock] = useState(createPlaybackClock);
  const [duration, setDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(loadVolume);
  const [playbackModes, setPlaybackModes] = useState<PlaybackModes>(loadPlaybackModes);

  // The engine in use: the hidden YouTube player here, or a linked TV (see tvOutput.ts).
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const localPlayerRef = useRef<YouTubePlayerInstance | null>(null);
  const tvPlayerRef = useRef<TvPlayer | null>(null);
  /** The TV playing instead of this computer, by id; null plays here. */
  const [output, setOutput] = useState<string | null>(null);
  const outputRef = useRef<string | null>(null);
  /** What the local player last held: it must not follow the queue while a TV is playing. */
  const [parkedVideoId, setParkedVideoId] = useState<string | undefined>(undefined);
  const isScrubbingRef = useRef(false);
  // Same value as the clock, under the name the callbacks below already use.
  const currentTimeRef = useMemo(() => ({ get current() { return clock.get(); } }), [clock]);
  const setCurrentTime = clock.set;
  const durationRef = useRef(0);
  const playerStateRef = useRef<YouTubePlaybackState>("unstarted");
  const volumeRef = useRef(volume);
  const isMutedRef = useRef(isMuted);
  const playbackModesRef = useRef(playbackModes);
  const preShuffleOrderRef = useRef<SearchResult[] | null>(null);
  const recordedTrackIdRef = useRef<string | null>(null);
  const shouldAutoPlayRef = useRef(false);
  const queueFilledForRef = useRef<string | null>(null);

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
    playerRef.current?.setVolume?.(v);
    if (v === 0 && !isMutedRef.current) {
      playerRef.current?.mute?.();
      setIsMuted(true);
    } else if (v > 0 && isMutedRef.current) {
      playerRef.current?.unMute?.();
      setIsMuted(false);
    }
    if (v > 0) saveVolume(v);
  }, []);

  const toggleMute = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (isMutedRef.current) {
      player.unMute?.();
      setIsMuted(false);
      if (volumeRef.current === 0) {
        setVolume(100);
        volumeRef.current = 100;
        player.setVolume?.(100);
      }
    } else {
      player.mute?.();
      setIsMuted(true);
    }
  }, []);

  // Transport
  const seekTo = useCallback(
    (seconds: number) => {
      if (!playerRef.current) return;
      const total = durationRef.current;
      const target = Math.max(0, Math.min(total > 0 ? total : seconds, seconds));
      playerRef.current.seekTo(target, true);
      setCurrentTime(target);
      persistCurrentPosition(target);
    },
    [persistCurrentPosition],
  );

  const seekRelative = useCallback(
    (deltaSeconds: number) => {
      if (!playerRef.current || !isPlayerReady) return;
      const total = durationRef.current;
      const target = Math.max(
        0,
        Math.min(total > 0 ? total : 999999, currentTimeRef.current + deltaSeconds),
      );
      playerRef.current.seekTo(target, true);
      setCurrentTime(target);
      persistCurrentPosition(target);
    },
    [isPlayerReady, persistCurrentPosition],
  );

  const togglePlayPause = useCallback(() => {
    if (!playerRef.current || !isPlayerReady) return;
    if (playerStateRef.current === "playing") {
      playerRef.current.pauseVideo();
      persistCurrentPosition(currentTimeRef.current);
    } else {
      if (playerStateRef.current === "ended") {
        playerRef.current.seekTo(0, true);
        setCurrentTime(0);
      }
      playerRef.current.playVideo();
    }
  }, [isPlayerReady, persistCurrentPosition]);

  /** Scrubber drag: the slider moves freely and the player seeks once on release. */
  const beginScrub = useCallback(() => {
    isScrubbingRef.current = true;
  }, []);

  const scrubTo = useCallback((seconds: number) => {
    setCurrentTime(seconds);
    if (!isScrubbingRef.current) {
      playerRef.current?.seekTo(seconds, true);
    }
  }, []);

  const endScrub = useCallback(
    (seconds: number) => {
      isScrubbingRef.current = false;
      playerRef.current?.seekTo(seconds, true);
      persistCurrentPosition(seconds);
    },
    [persistCurrentPosition],
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
    recordedTrackIdRef.current = null;
    cacheTrack(track);
    setCurrentTime(0);
    setDuration(0);
    setPlaybackError(null);
    setPlayerState("buffering");

    const player = playerRef.current;
    if (player) {
      if (typeof player.loadVideoById === "function") {
        player.loadVideoById({ videoId: track.videoId, startSeconds: 0 });
      }
      player.playVideo?.();
    }
  }, []);

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

    if (repeat === "one" && current.currentTrack && playerRef.current) {
      playerRef.current.seekTo(0, true);
      setCurrentTime(0);
      playerRef.current.playVideo();
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
  }, [commitSession, playAutoplayFrom, startTrack]);

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
      playerRef.current?.seekTo(0, true);
      setCurrentTime(0);
      return;
    }

    const { history } = sessionRef.current;
    if (history.length > 0) {
      const prevTrack = history[history.length - 1];
      startTrack(prevTrack, (prev) => playTrackImmediate(prev, prevTrack));
      return;
    }

    playerRef.current?.seekTo(0, true);
    setCurrentTime(0);
  }, [startTrack]);

  // Hidden player callbacks
  useEffect(() => {
    handleTrackCompletedRef.current = handleTrackCompleted;
    handleNextTrackRef.current = handleNextTrack;
  }, [handleTrackCompleted, handleNextTrack]);

  const handlePlayerReady = useCallback((player: YouTubePlayerInstance) => {
    localPlayerRef.current = player;
    if (!outputRef.current) playerRef.current = player;
    setIsPlayerReady(true);
    player.setVolume?.(volumeRef.current);
    const initialDuration = player.getDuration();
    if (initialDuration > 0) {
      setDuration(initialDuration);
    }
    if (shouldAutoPlayRef.current) {
      player.playVideo();
      shouldAutoPlayRef.current = false;
    }
  }, []);

  const skipsInARowRef = useRef(0);
  const engineStateChange = useCallback(
    (state: YouTubePlaybackState) => {
      setPlayerState(state);
      if (state === "playing") {
        skipsInARowRef.current = 0;
        setPlaybackError(null);
      } else if (state === "ended") {
        recordIfNeeded(sessionRef.current.currentTrack);
        void handleTrackCompletedRef.current();
      }
    },
    [recordIfNeeded],
  );

  const engineError = useCallback(
    (code: number) => {
      setPlayerState("paused");
      const message = PLAYER_ERROR_MESSAGES[code] ?? `Playback failed with error code ${code}.`;
      setPlaybackError(message);
      if (UNPLAYABLE_ERRORS.has(code) && skipsInARowRef.current < MAX_SKIPS_IN_A_ROW) {
        skipsInARowRef.current += 1;
        const title = sessionRef.current.currentTrack?.title;
        showToast(title ? `Skipped “${title}”: it can't be played here.` : "Skipped a song that can't be played here.");
        void handleNextTrackRef.current();
      }
    },
    [showToast],
  );

  // The local player's own events are noise while a TV is the one playing.
  const handlePlayerStateChange = useCallback(
    (state: YouTubePlaybackState) => {
      if (!outputRef.current) engineStateChange(state);
    },
    [engineStateChange],
  );
  const handlePlayerError = useCallback(
    (code: number) => {
      if (!outputRef.current) engineError(code);
    },
    [engineError],
  );

  // Latest versions for the TV engine, which outlives any one render.
  const engineRef = useRef({ engineStateChange, engineError, handlePreviousTrack });
  useEffect(() => {
    engineRef.current = { engineStateChange, engineError, handlePreviousTrack };
  });

  /**
   * Moves playback to a linked TV (by id) or back to this computer (null). The song and
   * position carry over. `resume: false` lands paused: used when a TV drops out, so the
   * computer doesn't suddenly start playing out loud.
   */
  const selectOutput = useCallback((id: string | null, resume = true) => {
    const previous = outputRef.current;
    if (id === previous) return;
    const track = sessionRef.current.currentTrack;
    const at = currentTimeRef.current;
    const wasPlaying = resume && (playerStateRef.current === "playing" || playerStateRef.current === "buffering");

    if (previous) {
      void sendToTv(previous, { t: "stop" });
      tvPlayerRef.current = null;
    } else {
      localPlayerRef.current?.pauseVideo();
      setParkedVideoId(track?.videoId);
    }

    outputRef.current = id;
    setOutput(id);
    if (id) {
      tvPlayerRef.current = createTvPlayer(id, {
        onStateChange: (state) => engineRef.current.engineStateChange(state),
        onError: (code) => engineRef.current.engineError(code),
        onKey: (key) => {
          if (key === "next") void handleNextTrackRef.current();
          else engineRef.current.handlePreviousTrack();
        },
        onReleased: () => {
          if (outputRef.current !== id) return;
          selectOutputRef.current(null, false);
          showToastRef.current("The TV started playing something else. Playback is back on this computer, paused.");
        },
      });
    }
    const player = id ? (tvPlayerRef.current?.player ?? null) : localPlayerRef.current;
    playerRef.current = player;
    if (!player) return;

    player.setVolume?.(volumeRef.current);
    if (isMutedRef.current) player.mute?.();
    else player.unMute?.();
    if (!track?.videoId) return;
    if (wasPlaying) {
      player.loadVideoById?.({ videoId: track.videoId, startSeconds: at });
      setPlayerState("buffering");
    } else {
      player.cueVideoById?.({ videoId: track.videoId, startSeconds: at });
      setPlayerState("paused");
    }
  }, []);

  const selectOutputRef = useRef(selectOutput);
  const showToastRef = useRef(showToast);
  useEffect(() => {
    selectOutputRef.current = selectOutput;
    showToastRef.current = showToast;
  });

  // What the TV reports, and the TV going away.
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const keep = (fn: () => void) => (disposed ? fn() : unlisteners.push(fn));
    void listen<{ id: string; message: unknown }>("tv-message", ({ payload }) => {
      if (payload.id === outputRef.current) tvPlayerRef.current?.handleMessage(payload.message);
    }).then(keep);
    void listen("tvs-changed", () => {
      const playingOn = outputRef.current;
      if (!playingOn) return;
      void getTvs().then((status) => {
        if (outputRef.current !== playingOn) return;
        if (status.linked.some((tv) => tv.id === playingOn && tv.online)) return;
        selectOutput(null, false);
        showToast("The TV disconnected. Playback is back on this computer, paused.");
      }, () => {});
    }).then(keep);
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [selectOutput, showToast]);

  // The TV's screen: what's playing and what's next.
  const upNext = session.upcoming;
  useEffect(() => {
    if (!output) return;
    const describe = (track: SearchResult) => ({
      videoId: track.videoId,
      title: cleanDisplayTitle(track.title),
      artist: track.artist,
      thumb: optimizeThumbnailUrl(track.thumbnailUrl, track.videoId, "hero"),
    });
    void sendToTv(output, {
      t: "now",
      track: currentTrack ? describe(currentTrack) : null,
      upcoming: upNext.slice(0, 5).map(describe),
    });
  }, [output, currentTrack, upNext]);

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

  // Progress sync: 100 ms while playing keeps lyrics tight, 250 ms otherwise.
  useEffect(() => {
    if (!isPlayerReady || !currentTrack) return;

    const syncPlayerTime = () => {
      const player = playerRef.current;
      if (!player) return;
      if (!isScrubbingRef.current) {
        setCurrentTime(player.getCurrentTime());
      }
      const currentDuration = player.getDuration();
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

  useSystemMediaControls({
    track: currentTrack,
    playerState,
    clock,
    duration,
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
    // where it plays
    output,
    selectOutput,
    /** The song the hidden local player should hold: frozen while a TV is playing. */
    hiddenPlayerVideoId: output ? parkedVideoId : currentTrack?.videoId,
    // hidden player
    handlePlayerReady,
    handlePlayerStateChange,
    handlePlayerError,
    handleTrackChangeFromIframe,
  };
}
