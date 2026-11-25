import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPin,
  DEFAULT_PROVIDERS,
  getPin,
  lyricsPrefsVersion,
  providerOrderArg,
  readProviderSettings,
  resetProviderSettings,
  setPin,
  subscribeLyricsPrefs,
  writeProviderSettings,
  type ProviderSetting,
} from "./lyricsPrefs";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const settings = DEFAULT_PROVIDERS.map((name) => ({ name, on: true }));

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readProviderSettings", () => {
  it("uses every known provider in order when nothing is saved", () => {
    expect(readProviderSettings(["A", "B", "C"])).toEqual([
      { name: "A", on: true },
      { name: "B", on: true },
      { name: "C", on: true },
    ]);
  });

  it("keeps the saved order and switches, drops unknown names, appends new ones on", () => {
    writeProviderSettings([
      { name: "B", on: false },
      { name: "Gone", on: true },
      { name: "A", on: true },
    ]);
    expect(readProviderSettings(["A", "B", "C"])).toEqual([
      { name: "B", on: false },
      { name: "A", on: true },
      { name: "C", on: true },
    ]);
  });

  it("survives broken stored data", () => {
    localStorage.setItem("dot_lyrics_providers_v1", "{not json");
    expect(readProviderSettings(["A"])).toEqual([{ name: "A", on: true }]);
  });
});

describe("providerOrderArg", () => {
  it("is undefined for the default order with every provider on", () => {
    expect(providerOrderArg(settings)).toBeUndefined();
  });

  it("lists the enabled providers when one is off", () => {
    const off = settings.map((setting, index) => (index === 2 ? { ...setting, on: false } : setting));
    expect(providerOrderArg(off)).toEqual(DEFAULT_PROVIDERS.filter((_, index) => index !== 2));
  });

  it("lists the new order when providers are rearranged", () => {
    const moved = [settings[1], settings[0], ...settings.slice(2)];
    expect(providerOrderArg(moved)).toEqual([DEFAULT_PROVIDERS[1], DEFAULT_PROVIDERS[0], ...DEFAULT_PROVIDERS.slice(2)]);
  });

  it("resets to undefined after resetProviderSettings", () => {
    writeProviderSettings([{ name: DEFAULT_PROVIDERS[0], on: false }]);
    resetProviderSettings();
    expect(providerOrderArg(readProviderSettings(DEFAULT_PROVIDERS))).toBeUndefined();
  });
});

describe("pins", () => {
  it("remembers a provider for one song only", () => {
    setPin("song-a", "LRCLIB");
    expect(getPin("song-a")).toBe("LRCLIB");
    expect(getPin("song-b")).toBeUndefined();
  });

  it("clears a pin", () => {
    setPin("song-a", "LRCLIB");
    clearPin("song-a");
    expect(getPin("song-a")).toBeUndefined();
  });

  it("notifies listeners and bumps the version on changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLyricsPrefs(listener);
    const before = lyricsPrefsVersion();
    setPin("song-a", "Unison");
    writeProviderSettings([{ name: "Unison", on: true }]);
    resetProviderSettings();
    clearPin("song-a");
    expect(listener).toHaveBeenCalledTimes(4);
    expect(lyricsPrefsVersion()).toBe(before + 4);
    unsubscribe();
  });

  it("doesn't notify when the pin is already set", () => {
    setPin("song-a", "LRCLIB");
    const listener = vi.fn();
    const unsubscribe = subscribeLyricsPrefs(listener);
    setPin("song-a", "LRCLIB");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("writeProviderSettings", () => {
  it("round-trips settings through storage", () => {
    const saved: ProviderSetting[] = [
      { name: "YouTube Music", on: false },
      { name: "LRCLIB", on: true },
    ];
    writeProviderSettings(saved);
    expect(readProviderSettings(["LRCLIB", "YouTube Music"])).toEqual(saved);
  });
});
