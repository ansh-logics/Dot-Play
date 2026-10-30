import { StrictMode, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { pretendTauri } from "./control";
import { SONG, loadCover, seedAppStorage, songTrack } from "./song";

/**
 * Capture page (dev only, used by `npm run capture`): the app's real Now Playing screen in a
 * given state, read from the URL, e.g. `?skin=vinyl&time=64&playing=1&lyrics=0`.
 */
const params = new URLSearchParams(location.search);
const SKIN = params.get("skin") ?? "apple";
const TIME = Number(params.get("time") ?? 64);
const PLAYING = params.get("playing") !== "0";
const LYRICS = params.get("lyrics") === "1";
const noop = () => {};

async function boot() {
  pretendTauri();
  const cover = await loadCover();
  seedAppStorage(cover);
  localStorage.setItem("dot_player_skin", SKIN);
  await import("@app/index.css");
  await import("@app/App.css");
  const { NowPlaying } = await import("@app/components/now-playing/NowPlaying");
  const track = songTrack(cover);

  function Screen() {
    const session = useMemo(() => ({ history: [], currentTrack: track, upcoming: [], currentTime: 0, isAutoplay: false }), []);
    const modes = useMemo(() => ({ repeat: "off" as const, shuffle: false, autoplay: true }), []);

    // Lyrics follow the app's own L shortcut (on by default on wide screens).
    useEffect(() => {
      const id = window.setInterval(() => {
        const btn = document.querySelector<HTMLElement>('.np-icon-btn[aria-label="Lyrics"]');
        if (!btn || btn.hasAttribute("disabled")) return;
        const on = btn.getAttribute("aria-pressed") === "true";
        if (on !== LYRICS) window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
        else {
          window.clearInterval(id);
          document.body.dataset.ready = "1";
        }
      }, 200);
      return () => window.clearInterval(id);
    }, []);

    return (
      <NowPlaying
        isOpen
        onClose={noop}
        session={session}
        history={[]}
        isPlaying={PLAYING}
        isBuffering={false}
        isReady
        currentTime={TIME}
        duration={SONG.duration}
        playbackError={null}
        volume={70}
        isMuted={false}
        modes={modes}
        onPlayPause={noop}
        onNext={noop}
        onPrevious={noop}
        onSeek={noop}
        onToggleMute={noop}
        onVolumeChange={noop}
        onCycleRepeat={noop}
        onToggleAutoplay={noop}
        onToggleShuffle={noop}
        onSelectTrack={noop}
        onReorderUpcoming={noop}
        onRemoveUpcoming={noop}
        onClearUpcoming={noop}
        onPlayNext={noop}
        onAddToQueue={noop}
      />
    );
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Screen />
    </StrictMode>,
  );
}

void boot();
