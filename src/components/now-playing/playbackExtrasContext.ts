import { createContext } from "react";
import type { SleepTimer } from "../../lib/playbackExtras";

/** Speed and sleep timer, shared from App so the deck needs no props threaded to it. */
export const PlaybackExtrasContext = createContext<{
  playbackRate: number;
  /** False while a TV plays: it only plays at normal speed. */
  canChangeRate: boolean;
  changePlaybackRate: (rate: number) => void;
  sleepTimer: SleepTimer;
  startSleepTimer: (minutes: number) => void;
  sleepAtEndOfTrack: () => void;
  cancelSleepTimer: () => void;
} | null>(null);
