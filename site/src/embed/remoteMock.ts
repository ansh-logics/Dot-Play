import { useMemo } from "react";

/**
 * Stand-in for the Phone Remote's connection (src/remote/useRemoteState.ts) on the capture
 * page: a connected phone with a song, an Up Next queue and search results, no relay.
 * Swapped in by the site's Vite config for imports from src/remote/.
 */
export type RemoteNowPlaying = {
  title: string;
  artist: string;
  duration: number;
  position: number;
  isPlaying: boolean;
  artworkUrl: string | null;
  videoId: string | null;
  ageMs: number;
  receivedAt: number;
};

declare global {
  interface Window {
    __remoteMock: { np: RemoteNowPlaying; upcoming: Array<{ videoId: string; title: string; artist: string; thumb: string }>; hits: unknown[] };
  }
}

const noop = () => {};

export function useRemoteState() {
  const mock = window.__remoteMock;
  const state = useMemo(
    () => ({
      upcoming: mock.upcoming,
      total: mock.upcoming.length,
      shuffle: false,
      repeat: "off" as const,
      autoplay: true,
      volume: 72,
      muted: false,
      skin: "apple" as const,
      liked: true,
    }),
    [mock],
  );
  return {
    connection: { kind: "connected" as const },
    np: mock.np,
    state,
    send: noop,
    requestLyrics: async () => null,
    requestSearch: async () => mock.hits,
    computer: "Mac",
  };
}

export function usePosition(np: RemoteNowPlaying | null): number {
  return np?.position ?? 0;
}

export function computerWord() {
  return "Mac";
}
