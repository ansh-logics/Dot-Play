import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createControl, pretendTauri } from "./control";
import { SONG, SONG_ID, loadCover, seedAppStorage } from "./song";
import { emitLocal, handleCommand } from "./tauriMock";

/**
 * Capture page (dev only, used by `npm run capture`): the app's real menu bar mini player,
 * e.g. `?time=84&playing=1`.
 */
interface TrayControl {
  position: number;
  playing: boolean;
  ready: boolean;
}

const params = new URLSearchParams(location.search);
const { control, useControl } = createControl<TrayControl>({
  position: Number(params.get("time") ?? 84),
  playing: params.get("playing") !== "0",
  ready: false,
});

async function boot() {
  pretendTauri();
  const cover = await loadCover();
  seedAppStorage(cover);

  const snapshot = () => {
    const c = control.get();
    return {
      title: SONG.title,
      artist: SONG.artist,
      album: null,
      duration: SONG.duration,
      position: c.position,
      isPlaying: c.playing,
      artworkUrl: cover,
      videoId: SONG_ID,
      updatedAtMs: Date.now(),
    };
  };
  handleCommand("get_now_playing", snapshot);

  await import("@app/tray/TrayPlayer.css");
  const { TrayPlayer } = await import("@app/tray/TrayPlayer");

  function Tray() {
    const c = useControl();
    useEffect(() => {
      emitLocal("now-playing", snapshot());
    }, [c.position, c.playing]);
    useEffect(() => {
      // The main window would answer the popover's "ready" with the queue and modes.
      const id = window.setTimeout(
        () => emitLocal("tray-state", { upcoming: [], shuffle: false, repeat: "off", autoplay: true, volume: 72, muted: false }),
        250,
      );
      return () => window.clearTimeout(id);
    }, []);
    return <TrayPlayer />;
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Tray />
    </StrictMode>,
  );
  control.set({ ready: true });
  window.setTimeout(() => (document.body.dataset.ready = "1"), 600);
}

void boot();
