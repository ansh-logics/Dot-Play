import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Check, Gauge, Moon } from "lucide-react";
import {
  formatRate,
  formatSleepRemaining,
  PLAYBACK_RATES,
  SLEEP_PRESETS_MIN,
  sleepRemainingMs,
  type SleepTimer,
} from "../../lib/playbackExtras";

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

/** Re-renders every second while a timed sleep timer runs, for the countdown. */
function useSleepRemaining(timer: SleepTimer): number | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (timer?.kind !== "at") return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timer]);
  return sleepRemainingMs(timer, now);
}

/** "Speed and sleep": playback speed, and a timer that stops the music. */
export function PlaybackExtrasPicker() {
  const context = useContext(PlaybackExtrasContext);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const remaining = useSleepRemaining(context?.sleepTimer ?? null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // The player leaves Esc alone while a menu is open (NowPlaying.tsx), so this closes only the menu.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!context) return null;
  const { playbackRate, canChangeRate, sleepTimer } = context;
  const fast = canChangeRate && playbackRate !== 1;
  const sleepLabel =
    sleepTimer?.kind === "endOfTrack" ? "End of song" : remaining !== null ? formatSleepRemaining(remaining) : null;
  const active = fast || Boolean(sleepTimer);
  const summary = [fast ? formatRate(playbackRate) : null, sleepLabel].filter(Boolean).join(" · ");
  const label = summary ? `Speed and sleep timer: ${summary}` : "Speed and sleep timer";

  const pick = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <div className="np-output np-extras" ref={rootRef}>
      <button
        type="button"
        className={`np-pill np-round-btn ${active ? "is-on" : ""}`}
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        {sleepTimer ? <Moon size={18} /> : <Gauge size={19} />}
        {summary && <span className="np-output-on">{summary}</span>}
      </button>
      {open && (
        <div className="np-output-menu np-extras-menu" role="menu" aria-label="Speed and sleep timer">
          <span className="np-output-title">Speed</span>
          <div className="np-extras-rates" role="group" aria-label="Playback speed">
            {PLAYBACK_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                role="menuitemradio"
                aria-checked={playbackRate === rate}
                className={`np-extras-rate ${playbackRate === rate ? "is-on" : ""}`}
                disabled={!canChangeRate}
                onClick={() => context.changePlaybackRate(rate)}
              >
                {formatRate(rate)}
              </button>
            ))}
          </div>
          {!canChangeRate && <small className="np-extras-note">A TV plays at normal speed.</small>}

          <span className="np-output-title">Sleep timer</span>
          {SLEEP_PRESETS_MIN.map((minutes) => {
            const on = sleepTimer?.kind === "at" && sleepTimer.minutes === minutes;
            return (
              <button
                key={minutes}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className="np-output-item"
                onClick={() => pick(() => context.startSleepTimer(minutes))}
              >
                <span className="np-output-name">
                  {minutes === 60 ? "1 hour" : `${minutes} minutes`}
                  {on && remaining !== null && <small>{formatSleepRemaining(remaining)} left</small>}
                </span>
                {on && <Check size={16} />}
              </button>
            );
          })}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={sleepTimer?.kind === "endOfTrack"}
            className="np-output-item"
            onClick={() => pick(context.sleepAtEndOfTrack)}
          >
            <span className="np-output-name">End of this song</span>
            {sleepTimer?.kind === "endOfTrack" && <Check size={16} />}
          </button>
          {sleepTimer && (
            <button type="button" role="menuitem" className="np-output-item" onClick={() => pick(context.cancelSleepTimer)}>
              <span className="np-output-name">Turn off timer</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
