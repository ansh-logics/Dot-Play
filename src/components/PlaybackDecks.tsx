import { useMemo } from "react";
import { HiddenYouTubePlayer } from "./HiddenYouTubePlayer";
import type { DeckSlot } from "../lib/engine/deck";
import { youtubeDeck, youtubeError } from "../lib/engine/youtubeDeck";

/** The app's playback decks: one plays, the other gets the next song ready for crossfades. */
export function PlaybackDecks({ slots }: { slots: DeckSlot[] }) {
  return (
    <>
      {slots.map((slot) => (
        <YouTubeDeckView key={slot.key} slot={slot} />
      ))}
    </>
  );
}

/** A deck played by a hidden YouTube player. */
function YouTubeDeckView({ slot }: { slot: DeckSlot }) {
  const { onReady, onError, onStateChange, onTrackInfo } = slot;
  const handlers = useMemo(
    () => ({
      onReady: (player: Parameters<typeof youtubeDeck>[0]) => onReady(youtubeDeck(player)),
      onError: (code: number) => onError(youtubeError(code)),
    }),
    [onReady, onError],
  );
  return (
    <HiddenYouTubePlayer
      videoId={slot.track?.videoId}
      initialSeconds={slot.initialSeconds}
      autoPlayOnMount={slot.autoplay}
      onReady={handlers.onReady}
      onStateChange={onStateChange}
      onError={handlers.onError}
      onTrackChange={onTrackInfo}
    />
  );
}
