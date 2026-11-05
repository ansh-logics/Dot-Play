import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SONG, loadCover } from "./song";

/**
 * Capture page (dev only, used by `npm run capture`): the Phone Remote's real page with a
 * stand-in connection (remoteMock.ts). Search results are made-up songs with drawn covers.
 */
const params = new URLSearchParams(location.search);
const TIME = Number(params.get("time") ?? 64);

/** A gradient square with the song's initials, as a data URL. */
function drawnCover(seed: number, text: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 240;
  const ctx = canvas.getContext("2d")!;
  const hue = (seed * 67) % 360;
  const gradient = ctx.createLinearGradient(0, 0, 240, 240);
  gradient.addColorStop(0, `hsl(${hue} 70% 55%)`);
  gradient.addColorStop(1, `hsl(${(hue + 50) % 360} 60% 22%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 240, 240);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "700 72px Space Grotesk, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 120, 126);
  return canvas.toDataURL("image/jpeg", 0.9);
}

const MADE_UP = [
  ["Night Drive", "Neon Avenue"],
  ["Night Drive (Acoustic)", "Neon Avenue"],
  ["Midnight Highway", "The Lanterns"],
  ["Drive Slow", "Mira Sol"],
  ["Night Shift Radio", "Static Hearts"],
  ["Headlights", "Juniper Coast"],
];

async function boot() {
  const cover = await loadCover();
  const songs = MADE_UP.map(([title, artist], i) => ({
    videoId: `madeup${String(i).padStart(5, "0")}`,
    title,
    artist,
    thumbnailUrl: drawnCover(i + 2, title.split(" ").map((w) => w[0]).join("").slice(0, 2)),
    duration: `${3 + (i % 2)}:${String(10 + i * 7).padStart(2, "0")}`,
  }));
  window.__remoteMock = {
    np: {
      title: SONG.title,
      artist: SONG.artist,
      duration: SONG.duration,
      position: TIME,
      isPlaying: true,
      artworkUrl: cover,
      videoId: "site-song",
      ageMs: 0,
      receivedAt: Date.now(),
    },
    upcoming: songs.slice(2).map((s) => ({ videoId: s.videoId, title: s.title, artist: s.artist, thumb: s.thumbnailUrl })),
    hits: songs,
  };
  await import("@app/remote/remote.css");
  const { RemoteApp } = await import("@app/remote/RemoteApp");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RemoteApp />
    </StrictMode>,
  );
  // Let fonts, the cover and the album colours settle.
  window.setTimeout(() => (document.body.dataset.ready = "1"), 600);
}

void boot();
