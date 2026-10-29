import { emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { TrayCommand } from "../lib/useTrayBridge";

export type { TrayCommand, TrayQueueItem, TrayState } from "../lib/useTrayBridge";

/** Mirrors `NowPlayingSnapshot` in src-tauri/src/media_controls.rs. */
export interface NowPlaying {
  title: string;
  artist: string;
  duration: number;
  position: number;
  isPlaying: boolean;
  artworkUrl: string | null;
  videoId: string | null;
  /** When `position` was sampled (ms since epoch). */
  updatedAtMs: number;
}

type MediaAction =
  | { action: "toggle" | "next" | "previous" }
  | { action: "seek"; position: number };

/** Play/pause, skip and seek: the same path as the system media keys. */
export const media = (action: MediaAction) => {
  void invoke("tray_media_control", { action }).catch(() => {});
};

/** Queue, modes and volume: applied by the main window (see useTrayBridge). */
export const command = (cmd: TrayCommand) => {
  void emitTo("main", "tray-command", cmd).catch(() => {});
};

export { formatTime } from "../lib/formatTime";
