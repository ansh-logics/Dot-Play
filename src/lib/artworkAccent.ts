import { useEffect, useSyncExternalStore } from "react";
import { useArtwork } from "./imagePipeline";
import { useArtworkPalette, type ArtworkPalette } from "./useArtworkPalette";
import type { SearchResult } from "./search";

/**
 * "Colours from the album art": the app's accent (DOT red by default) follows the playing
 * song's cover. Off by default; the black stays black either way, only the accent changes.
 */

const STORAGE_KEY = "dot_artwork_accent";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = read();

export function setArtworkAccentEnabled(on: boolean): void {
  enabled = on;
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
  listeners.forEach((fn) => fn());
}

export function useArtworkAccentEnabled(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => enabled,
  );
}

type Hsl = [number, number, number];

/** Reads "hsl(210 45% 30%)" (the palette's format) into [hue, saturation 0–1, lightness 0–1]. */
export function parseHsl(value: string): Hsl | null {
  const m = value.match(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i);
  return m ? [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100] : null;
}

function hslToRgb([h, s, l]: Hsl): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

/** WCAG contrast ratio of white text on this colour. */
export function contrastWithWhite(color: Hsl): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = hslToRgb(color).map(lin);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05);
}

const css = ([h, s, l]: Hsl, alpha?: number) =>
  `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%${alpha === undefined ? "" : ` / ${alpha}`})`;

export interface AccentColours {
  accent: string;
  hover: string;
  glow: string;
  subtle: string;
}

/** Below this saturation a cover is treated as grey, and DOT red stays. */
const MIN_SATURATION = 0.35;
/** White text on the accent (buttons, badges) stays at least this readable. */
const MIN_CONTRAST = 3;

/**
 * The accent for a cover: its most colourful palette colour, made vivid, then darkened until
 * white text on it is readable. Null for grey covers.
 */
export function accentFromPalette(palette: Pick<ArtworkPalette, "colors">): AccentColours | null {
  const colours = palette.colors.map(parseHsl).filter((c): c is Hsl => c !== null);
  const vivid = colours.reduce<Hsl | null>((best, c) => (!best || c[1] > best[1] ? c : best), null);
  if (!vivid || vivid[1] < MIN_SATURATION) return null;
  const h = vivid[0];
  const s = Math.min(0.9, Math.max(0.6, vivid[1]));
  let l = 0.55;
  while (l > 0.3 && contrastWithWhite([h, s, l]) < MIN_CONTRAST) l -= 0.02;
  return {
    accent: css([h, s, l]),
    hover: css([h, s, Math.min(l + 0.06, 0.62)]),
    glow: css([h, s, l], 0.45),
    subtle: css([h, s, l], 0.16),
  };
}

const VARS = ["--accent-red", "--accent-red-hover", "--accent-red-glow", "--accent-red-subtle"] as const;

/** Points the app's accent at the playing song's cover while the setting is on. */
export function useArtworkAccent(track: SearchResult | null | undefined) {
  const on = useArtworkAccentEnabled();
  const { currentUrl } = useArtwork({
    sourceUrl: on ? track?.thumbnailUrl : undefined,
    videoId: on ? track?.videoId : undefined,
    variant: "hero",
  });
  const palette = useArtworkPalette(on && track ? currentUrl : undefined);
  const colours = on && palette ? accentFromPalette(palette) : null;
  const key = colours ? `${colours.accent}|${colours.hover}` : "";

  useEffect(() => {
    const root = document.documentElement.style;
    if (!colours) {
      VARS.forEach((v) => root.removeProperty(v));
      return;
    }
    root.setProperty("--accent-red", colours.accent);
    root.setProperty("--accent-red-hover", colours.hover);
    root.setProperty("--accent-red-glow", colours.glow);
    root.setProperty("--accent-red-subtle", colours.subtle);
    // Keyed on the colour strings, not the object, so a re-render doesn't rewrite them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Turning the setting off (or leaving the app) puts DOT red back.
  useEffect(() => () => VARS.forEach((v) => document.documentElement.style.removeProperty(v)), []);
}
