import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  Infinity as InfinityIcon,
  Loader2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { PlaybackModes } from "../../lib/playbackModes";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface SliderProps {
  value: number;
  max: number;
  label: string;
  valueText: string;
  disabled?: boolean;
  step: number;
  className?: string;
  /** Called continuously while dragging. */
  onScrub?: (value: number) => void;
  /** Called once on release / keyboard step. */
  onCommit: (value: number) => void;
}

/** Pointer-captured slider. Shared by the progress bar and the volume control. */
function Slider({ value, max, label, valueText, disabled, step, className = "", onScrub, onCommit }: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const shown = dragValue ?? value;
  const pct = max > 0 ? Math.min(100, Math.max(0, (shown / max) * 100)) : 0;

  const valueAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * max;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.stopPropagation(); // never start a sheet drag from a slider
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = valueAt(e.clientX);
    setDragValue(v);
    onScrub?.(v);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragValue === null) return;
    const v = valueAt(e.clientX);
    setDragValue(v);
    onScrub?.(v);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (dragValue === null) return;
    const v = valueAt(e.clientX);
    setDragValue(null);
    onCommit(v);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
    if (!delta && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the app's global ±5s seek
    const next = e.key === "Home" ? 0 : e.key === "End" ? max : Math.min(max, Math.max(0, value + delta));
    onCommit(next);
  };

  return (
    <div
      ref={trackRef}
      className={`np-slider ${dragValue !== null ? "is-dragging" : ""} ${disabled ? "is-disabled" : ""} ${className}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={valueText}
      aria-disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDragValue(null)}
      onKeyDown={onKeyDown}
      style={{ ["--np-pct" as string]: `${pct}%` }}
    >
      <div className="np-slider-rail">
        <div className="np-slider-fill" />
      </div>
      <div className="np-slider-knob" />
    </div>
  );
}

export interface ControlDeckProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isBuffering: boolean;
  isReady: boolean;
  volume: number;
  isMuted: boolean;
  modes: PlaybackModes;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (seconds: number) => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onCycleRepeat: () => void;
  onToggleAutoplay: () => void;
  onToggleShuffle: () => void;
}

export function ControlDeck(props: ControlDeckProps) {
  const { currentTime, duration, isPlaying, isBuffering, isReady, volume, isMuted, modes } = props;
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const shownTime = scrubTime ?? currentTime;
  const effectiveVolume = isMuted ? 0 : volume;
  const VolumeIcon = effectiveVolume === 0 ? VolumeX : effectiveVolume < 34 ? Volume : effectiveVolume < 67 ? Volume1 : Volume2;
  const repeatLabel = { off: "Repeat off", all: "Repeat all", one: "Repeat one" }[modes.repeat];

  return (
    <div className="np-deck">
      <div className="np-progress">
        <Slider
          value={currentTime}
          max={duration}
          step={5}
          label="Seek"
          valueText={`${formatTime(shownTime)} of ${formatTime(duration)}`}
          disabled={!isReady || duration <= 0}
          onScrub={setScrubTime}
          onCommit={(t) => {
            setScrubTime(null);
            props.onSeek(t);
          }}
        />
        <div className="np-times" aria-hidden="true">
          <span>{formatTime(shownTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="np-deck-row">
        <div className="np-pill np-modes" role="group" aria-label="Playback modes">
          <button
            type="button"
            className={`np-mode ${modes.repeat !== "off" ? "is-on" : ""}`}
            onClick={props.onCycleRepeat}
            aria-label={repeatLabel}
            aria-pressed={modes.repeat !== "off"}
            title={repeatLabel}
          >
            {modes.repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />}
          </button>
          <button
            type="button"
            className={`np-mode ${modes.autoplay ? "is-on" : ""}`}
            onClick={props.onToggleAutoplay}
            aria-label="Autoplay"
            aria-pressed={modes.autoplay}
            title={modes.autoplay ? "Autoplay on — keeps playing similar songs" : "Autoplay off"}
          >
            <InfinityIcon size={18} />
          </button>
          <button
            type="button"
            className={`np-mode ${modes.shuffle ? "is-on" : ""}`}
            onClick={props.onToggleShuffle}
            aria-label="Shuffle"
            aria-pressed={modes.shuffle}
            title={modes.shuffle ? "Shuffle on" : "Shuffle off"}
          >
            <Shuffle size={17} />
          </button>
        </div>

        <div className="np-transport">
          <button type="button" className="np-skip" onClick={props.onPrevious} disabled={!isReady} aria-label="Previous">
            <SkipBack size={22} fill="currentColor" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className={`np-play ${isBuffering ? "is-buffering" : ""}`}
            onClick={props.onPlayPause}
            disabled={!isReady}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {!isReady || isBuffering ? (
              <Loader2 size={18} className="np-spin" />
            ) : isPlaying ? (
              <Pause size={18} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={18} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />
            )}
          </button>
          <button type="button" className="np-skip" onClick={props.onNext} disabled={!isReady} aria-label="Next">
            <SkipForward size={22} fill="currentColor" strokeWidth={1.5} />
          </button>
        </div>

        <div className="np-pill np-volume">
          <button
            type="button"
            className="np-volume-btn"
            onClick={props.onToggleMute}
            aria-label={isMuted ? "Unmute" : "Mute"}
            title={isMuted ? "Unmute" : "Mute"}
          >
            <VolumeIcon size={18} />
          </button>
          <Slider
            className="np-volume-slider"
            value={effectiveVolume}
            max={100}
            step={5}
            label="Volume"
            valueText={`${Math.round(effectiveVolume)}%`}
            onScrub={props.onVolumeChange}
            onCommit={props.onVolumeChange}
          />
        </div>
      </div>
    </div>
  );
}
