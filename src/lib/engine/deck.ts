/**
 * A playback deck: one player that plays one song at a time. usePlayback runs two of them
 * (the second for crossfades) and only ever talks to them through this interface, so the
 * YouTube player can be joined later by a native engine (local files, Subsonic) without the
 * queue, crossfade, sleep timer or controls knowing which one is playing.
 *
 * Today the only implementation is the hidden YouTube player (youtubeDeck.ts).
 */

export type PlaybackState = "buffering" | "cued" | "ended" | "paused" | "playing" | "unstarted";

/** Where a deck's audio comes from. */
export type DeckSource = "youtube";

/** What a deck is asked to play. */
export interface DeckTrack {
  videoId: string;
}

/** A failure to play the current song. */
export interface DeckError {
  message: string;
  /** The song can never play on this deck (removed, private, blocked): move on to the next. */
  unplayable: boolean;
}

/**
 * What a deck can honestly say about the song it is playing. Anything the player doesn't
 * report is null rather than a guess: there is no bitrate here because the player doesn't
 * expose one.
 */
export interface DeckStats {
  source: DeckSource;
  videoId: string | null;
  /** Share of the song the player has buffered, 0–1; null when it doesn't say. */
  loadedFraction: number | null;
  /** The quality name the player reports (e.g. "hd720"); null when it doesn't say. */
  quality: string | null;
  /** Playback speed (1 = normal). */
  rate: number;
  /** Times playback dropped into buffering since the current song was loaded. */
  bufferingEvents: number;
}

export interface PlaybackDeck {
  readonly source: DeckSource;
  /** Loads a song, starting at `startSeconds`; playing it straight away, or left ready, paused. */
  load(track: DeckTrack, options: { startSeconds?: number; autoplay: boolean }): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  /** Position in the song, in seconds. */
  position(): number;
  /** Length of the song in seconds; 0 while unknown. */
  duration(): number;
  /** 0–100. */
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  /** Playback speed (1 = normal). */
  setRate(rate: number): void;
  /** The current song's technical numbers, for the "Stats for nerds" panel; optional
   *  because a deck may have nothing to report. */
  stats?(): DeckStats;
}

/** What a deck reports back. */
export interface DeckEvents {
  onReady: (deck: PlaybackDeck) => void;
  onStateChange: (state: PlaybackState) => void;
  onError: (error: DeckError) => void;
  /** Title and artist the source knows for the song playing, to fill in missing details. */
  onTrackInfo?: (info: { videoId: string; title?: string; artist?: string }) => void;
}

/** One deck as rendered by the app: what it should hold, and where its events go. */
export interface DeckSlot extends DeckEvents {
  key: string;
  /** The song the deck holds. Changing it loads that song (unless the deck already has it). */
  track?: DeckTrack;
  /** Where the first song starts when the deck is created (a restored position). */
  initialSeconds: number;
  /** Whether a song it's given starts playing on its own. */
  autoplay: boolean;
}
