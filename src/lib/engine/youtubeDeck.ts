import type { YouTubePlayerInstance } from "../../components/HiddenYouTubePlayer";
import type { DeckError, DeckStats, PlaybackDeck } from "./deck";

/** The hidden YouTube player as a playback deck. */

const ERROR_MESSAGES: Record<number, string> = {
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
const UNPLAYABLE = new Set([2, 100, 101, 150, 153]);

/** The IFrame API's state code for "buffering". */
const BUFFERING_STATE = 3;
/** …and for "playing". */
const PLAYING_STATE = 1;

export function youtubeError(code: number): DeckError {
  return {
    message: ERROR_MESSAGES[code] ?? `Playback failed with error code ${code}.`,
    unplayable: UNPLAYABLE.has(code),
  };
}

/** Runs a player call, returning `fallback` when the method is missing or the player throws. */
function read<T>(call: (() => T | undefined) | undefined, fallback: T): T {
  if (!call) return fallback;
  try {
    const value = call();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

const decks = new WeakMap<YouTubePlayerInstance, PlaybackDeck>();

/** The deck for a player; the same object every time, so decks can be compared. */
export function youtubeDeck(player: YouTubePlayerInstance): PlaybackDeck {
  const existing = decks.get(player);
  if (existing) return existing;

  /** The last speed asked for; YouTube doesn't always answer getPlaybackRate. */
  let lastRate: number | null = null;
  /** Buffering spells since the current song was loaded, and whether one is in progress. */
  let bufferingEvents = 0;
  let wasBuffering = false;
  /** The song has played since it loaded: the first load's buffering doesn't count. */
  let hasPlayed = false;

  player.addEventListener?.("onStateChange", (event) => {
    const buffering = event.data === BUFFERING_STATE;
    if (event.data === PLAYING_STATE) hasPlayed = true;
    if (buffering && !wasBuffering && hasPlayed) bufferingEvents += 1;
    wasBuffering = buffering;
  });

  const deck: PlaybackDeck = {
    source: "youtube",
    load: ({ videoId }, { startSeconds = 0, autoplay }) => {
      bufferingEvents = 0;
      wasBuffering = false;
      hasPlayed = false;
      if (autoplay) {
        player.loadVideoById?.({ videoId, startSeconds });
        player.playVideo?.();
      } else {
        player.cueVideoById?.({ videoId, startSeconds });
      }
    },
    play: () => player.playVideo(),
    pause: () => player.pauseVideo(),
    seek: (seconds) => player.seekTo(seconds, true),
    position: () => player.getCurrentTime(),
    duration: () => player.getDuration(),
    setVolume: (volume) => player.setVolume?.(volume),
    setMuted: (muted) => (muted ? player.mute?.() : player.unMute?.()),
    setRate: (rate) => {
      lastRate = rate;
      player.setPlaybackRate?.(rate);
    },
    stats: (): DeckStats => {
      const videoId = read(() => player.getVideoData().video_id, "") || null;
      const loadedFraction = read(() => player.getVideoLoadedFraction?.(), Number.NaN);
      // YouTube reports "unknown" before it has picked a quality: that isn't an answer.
      const reportedQuality = read(() => player.getPlaybackQuality?.(), "");
      const quality = reportedQuality && reportedQuality !== "unknown" ? reportedQuality : null;
      const reportedRate = read(() => player.getPlaybackRate?.(), Number.NaN);
      const rate = Number.isFinite(reportedRate) && reportedRate > 0 ? reportedRate : (lastRate ?? 1);
      return {
        source: "youtube",
        videoId,
        loadedFraction: Number.isFinite(loadedFraction) ? loadedFraction : null,
        quality,
        rate,
        bufferingEvents,
      };
    },
  };
  decks.set(player, deck);
  return deck;
}
