/**
 * Lyrics source choices that survive restarts: the order providers are tried in, which ones
 * are on, and a pinned provider for one particular song ("Wrong lyrics?").
 *
 * The Rust side owns the providers themselves; this module only remembers the listener's
 * choices and tells the lyrics hooks when they change.
 */

/** The provider order DOT Music uses when the backend hasn't been asked yet, or failed. */
export const DEFAULT_PROVIDERS: string[] = [
  "SimpMusic",
  "BiniLyrics",
  "lrc.red",
  "BetterLyrics",
  "LyricsPlus",
  "Unison",
  "LRCLIB",
  "YouTube Music",
];

const PROVIDERS_KEY = "dot_lyrics_providers_v1";
const PINS_KEY = "dot_lyrics_pins_v1";

export interface ProviderSetting {
  name: string;
  on: boolean;
}

let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  listeners.forEach((listener) => listener());
}

// The menu bar popover and immersive screens are separate windows sharing this storage: a
// choice made in Now Playing reaches them through the storage event.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === PROVIDERS_KEY || event.key === PINS_KEY) changed();
  });
}

/** Re-runs `listener` whenever the provider settings or a pin change; returns unsubscribe. */
export function subscribeLyricsPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Bumps on every change, for hook dependencies and cache keys. */
export function lyricsPrefsVersion(): number {
  return version;
}

function readProviderStorage(): ProviderSetting[] {
  try {
    const value = JSON.parse(localStorage.getItem(PROVIDERS_KEY) ?? "null");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const settings: ProviderSetting[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const name = (item as { name?: unknown }).name;
      if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      settings.push({ name, on: (item as { on?: unknown }).on !== false });
    }
    return settings;
  } catch {
    return [];
  }
}

function writeProviderStorage(settings: ProviderSetting[]) {
  try {
    localStorage.setItem(PROVIDERS_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: the order lasts for this session.
  }
}

function writePinStorage(pins: Record<string, string>) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // Storage unavailable: the pin lasts for this session.
  }
}

/**
 * The saved order, merged with the providers this build actually has: names the backend no
 * longer lists are dropped, and new ones join at the end, enabled.
 */
export function readProviderSettings(known: string[]): ProviderSetting[] {
  const knownSet = new Set(known);
  const merged = readProviderStorage().filter((setting) => knownSet.has(setting.name));
  const present = new Set(merged.map((setting) => setting.name));
  for (const name of known) {
    if (!present.has(name)) merged.push({ name, on: true });
  }
  return merged;
}

export function writeProviderSettings(settings: ProviderSetting[]) {
  writeProviderStorage(settings);
  changed();
}

/** Back to the default order, with every provider on. */
export function resetProviderSettings() {
  try {
    localStorage.removeItem(PROVIDERS_KEY);
  } catch {
    // Storage unavailable.
  }
  changed();
}

/**
 * The `providerOrder` argument for the backend. Undefined means "the default": every provider
 * on, in the default order. Otherwise it's the enabled providers in the listener's order.
 */
export function providerOrderArg(settings: ProviderSetting[]): string[] | undefined {
  const isDefault =
    settings.length === DEFAULT_PROVIDERS.length &&
    settings.every((setting, index) => setting.on && setting.name === DEFAULT_PROVIDERS[index]);
  return isDefault ? undefined : settings.filter((setting) => setting.on).map((setting) => setting.name);
}

function readPins(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const pins: Record<string, string> = {};
    for (const [videoId, provider] of Object.entries(value)) {
      if (typeof provider === "string" && provider.length > 0) pins[videoId] = provider;
    }
    return pins;
  } catch {
    return {};
  }
}

/** The provider this song's lyrics were pinned to, if any. */
export function getPin(videoId: string): string | undefined {
  return readPins()[videoId];
}

export function setPin(videoId: string, provider: string) {
  const pins = readPins();
  if (pins[videoId] === provider) return;
  pins[videoId] = provider;
  writePinStorage(pins);
  changed();
}

export function clearPin(videoId: string) {
  const pins = readPins();
  if (!(videoId in pins)) return;
  delete pins[videoId];
  writePinStorage(pins);
  changed();
}
