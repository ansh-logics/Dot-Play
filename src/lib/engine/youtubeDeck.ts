import type { YouTubePlayerInstance } from "../../components/HiddenYouTubePlayer";
import type { DeckError, PlaybackDeck } from "./deck";

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

export function youtubeError(code: number): DeckError {
  return {
    message: ERROR_MESSAGES[code] ?? `Playback failed with error code ${code}.`,
    unplayable: UNPLAYABLE.has(code),
  };
}

const decks = new WeakMap<YouTubePlayerInstance, PlaybackDeck>();

/** The deck for a player; the same object every time, so decks can be compared. */
export function youtubeDeck(player: YouTubePlayerInstance): PlaybackDeck {
  const existing = decks.get(player);
  if (existing) return existing;
  const deck: PlaybackDeck = {
    source: "youtube",
    load: ({ videoId }, { startSeconds = 0, autoplay }) => {
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
    setRate: (rate) => player.setPlaybackRate?.(rate),
  };
  decks.set(player, deck);
  return deck;
}
