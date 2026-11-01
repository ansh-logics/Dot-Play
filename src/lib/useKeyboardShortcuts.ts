import { useEffect, useEffectEvent } from "react";

interface KeyboardShortcutOptions {
  /** Closes the top-most popup; returns false when there was nothing to close. */
  onEscape: () => boolean;
  onTogglePlayPause: () => void;
  onSeekRelative: (seconds: number) => void;
  /** Returns false when nothing is playing, so the key is left alone. */
  onToggleNowPlaying: () => boolean;
  onFocusSearch: () => void;
  onOpenImmersive: () => void;
  onShowShortcuts: () => void;
}

const isTyping = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    target.isContentEditable ||
    target.getAttribute("role") === "textbox"
  );
};

/**
 * In-window shortcuts: Space play/pause, ←/→ seek 5 s, F Now Playing, I immersive mode,
 * / search, ? the shortcut list, Esc back one step. The full list is in lib/shortcuts.ts. Playback keys are ignored while typing.
 */
export function useKeyboardShortcuts(options: KeyboardShortcutOptions) {
  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape" && options.onEscape()) {
      e.preventDefault();
      return;
    }
    // Typing, or a key a focused control (e.g. the Top Picks carousel) already handled.
    if (isTyping(e.target) || e.defaultPrevented) return;

    if (e.code === "Space") {
      e.preventDefault();
      options.onTogglePlayPause();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      options.onSeekRelative(-5);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      options.onSeekRelative(5);
    } else if (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (options.onToggleNowPlaying()) e.preventDefault();
    } else if (e.key.toLowerCase() === "i" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      options.onOpenImmersive();
    } else if (e.key === "?") {
      e.preventDefault();
      options.onShowShortcuts();
    } else if (e.key === "/") {
      e.preventDefault();
      options.onFocusSearch();
    }
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => handleKeyDown(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
