import { pretendTauri } from "./control";
import { SONG, SONG_ID, loadCover, seedAppStorage } from "./song";
import { emitLocal, handleCommand } from "./tauriMock";

/**
 * Capture page (dev only, used by `npm run capture`): one display of the app's real immersive
 * mode, e.g. `?view=lyrics&skin=nothing&time=64&displays=2`.
 */
const params = new URLSearchParams(location.search);
const VIEW = params.get("view") ?? "stage";
const SKIN = params.get("skin") ?? "apple";
const TIME = Number(params.get("time") ?? 64);
const DISPLAYS = Number(params.get("displays") ?? 2);
const SCREEN_KEY = "site-display";

/** Every shot shows 9:41, like Apple's: the page's clock is moved to 9:41 today. */
function freezeClockAt(hour: number, minute: number) {
  const RealDate = Date;
  const target = new RealDate();
  target.setHours(hour, minute, 0, 0);
  const offset = target.getTime() - RealDate.now();
  class ShiftedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length) super(...args);
      else super(RealDate.now() + offset);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  window.Date = ShiftedDate as DateConstructor;
}

async function boot() {
  pretendTauri();
  freezeClockAt(9, 41);
  const cover = await loadCover();
  seedAppStorage(cover);
  localStorage.setItem("dot_player_skin", SKIN);
  // What Rust tells each immersive window about its display, and the view chosen for it.
  window.__IMMERSIVE__ = { index: 0, count: DISPLAYS, screenKey: SCREEN_KEY, trigger: "manual" };
  localStorage.setItem("dot_immersive_views", JSON.stringify({ [SCREEN_KEY]: VIEW }));

  handleCommand("get_now_playing", () => ({
    title: SONG.title,
    artist: SONG.artist,
    album: null,
    duration: SONG.duration,
    position: TIME,
    isPlaying: true,
    artworkUrl: cover,
    videoId: SONG_ID,
    updatedAtMs: Date.now(),
  }));
  handleCommand("list_immersive_displays", () => []);

  await import("@app/components/vinyl/vinyl.css");
  await import("@app/immersive/Immersive.css");
  const { Immersive } = await import("@app/immersive/Immersive");
  const { createRoot } = await import("react-dom/client");
  const { StrictMode } = await import("react");

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Immersive />
    </StrictMode>,
  );
  // The main window would answer the page's "ready" with the player style and the next song.
  window.setTimeout(() => emitLocal("immersive-state", { skin: SKIN, next: { title: "Save Your Tears", artist: "The Weeknd" } }), 250);
  window.setTimeout(() => (document.body.dataset.ready = "1"), 600);
}

void boot();
