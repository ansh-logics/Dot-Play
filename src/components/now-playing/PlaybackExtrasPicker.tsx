import { useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Gauge, Moon } from "lucide-react";
import {
  formatRate,
  formatSleepRemaining,
  PLAYBACK_RATES,
  SLEEP_PRESETS_MIN,
  sleepRemainingMs,
  type SleepTimer,
} from "../../lib/playbackExtras";
import { PlaybackExtrasContext } from "./playbackExtrasContext";
import { LiquidGlassSurface } from "../ui/LiquidGlassSurface";


/** Re-renders every second while a timed sleep timer runs, for the countdown. */
function useSleepRemaining(timer: SleepTimer): number | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (timer?.kind !== "at") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timer]);
  // `now` only ticks while a timer runs; a timer just set never shows more than its full length.
  return sleepRemainingMs(timer, timer?.kind === "at" ? Math.max(now, timer.deadline - timer.minutes * 60_000) : now);
}

/** Gap between the button and the menu above it, and the menu's margin from the screen edge. */
const MENU_GAP = 10;
const MENU_MARGIN = 16;

/**
 * Where the menu goes: above `anchor`, right-aligned with it, inside the Now Playing screen.
 * The controls card clips its contents (overflow: hidden for its rounded glass and sheet), so
 * the menu is drawn on the screen itself instead, and scrolls if the window is too short.
 */
function useMenuPlacement(open: boolean, anchor: RefObject<HTMLElement | null>) {
  const [placement, setPlacement] = useState<{ host: HTMLElement; style: CSSProperties } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = anchor.current;
      if (!el) return;
      const host = el.closest<HTMLElement>(".np-root") ?? document.body;
      const box = host.getBoundingClientRect();
      const button = el.getBoundingClientRect();
      setPlacement({
        host,
        style: {
          position: "absolute",
          right: Math.max(MENU_MARGIN, box.right - button.right),
          bottom: box.bottom - button.top + MENU_GAP,
          maxHeight: Math.max(160, button.top - box.top - MENU_GAP - MENU_MARGIN),
          overflowY: "auto",
        },
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchor]);
  return placement;
}

export interface PlaybackExtrasPickerProps {
  /** Whether the Now Playing view's technical panel is open. */
  statsOpen?: boolean;
  /** Opens or closes it; left out where there is no panel (e.g. a TV deck). */
  onToggleStats?: () => void;
}

/** "Speed and sleep": playback speed, and a timer that stops the music. */
export function PlaybackExtrasPicker({ statsOpen, onToggleStats }: PlaybackExtrasPickerProps) {
  const context = useContext(PlaybackExtrasContext);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const remaining = useSleepRemaining(context?.sleepTimer ?? null);
  const placement = useMenuPlacement(open, rootRef);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    // The player leaves Esc alone while a menu is open (NowPlaying.tsx). Caught in the capture
    // phase and stopped, so the app's own Esc (back to Home, then minimise) never sees it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
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
      {open && placement && createPortal(
        <LiquidGlassSurface
          ref={menuRef}
          as="div"
          variant="menu"
          radius={16}
          className="np-output-menu np-extras-menu"
          role="menu"
          aria-label="Speed and sleep timer"
          style={placement.style}
          // Keep clicks in the menu from starting a drag of the card or other screen gestures.
          onPointerDown={(event) => event.stopPropagation()}
          filterResolution={1}
        >
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

          {onToggleStats && (
            <>
              <span className="np-output-title">Diagnostics</span>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={Boolean(statsOpen)}
                className="np-output-item"
                onClick={() => pick(onToggleStats)}
              >
                <span className="np-output-name">Stats for nerds</span>
                {statsOpen && <Check size={16} />}
              </button>
            </>
          )}
        </LiquidGlassSurface>,
        placement.host,
      )}
    </div>
  );
}
