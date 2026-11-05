// Captures the app's real UI (rendered by the dev-only pages in embed/) as the site's
// product shots. Run `npm run dev` first, then `npm run capture`. Needs Google Chrome.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.SITE_URL ?? "http://localhost:5810";
const OUT = new URL("../public/shots/", import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

// Immersive mode at a 16:10 Mac display (1440×900 points), 2000px wide like the other shots.
const MAC = { size: [1440, 900], scale: 2000 / 1440 };
// The app window at the size of the other app shots (2000×1256).
const APP = { size: [1470, 923], scale: 2000 / 1470 };
// A phone (390×844 points, like an iPhone 15) at 2×.
const PHONE = { size: [390, 844], scale: 2 };
const shots = [
  { file: "app-cassette.jpg", page: "nowplaying", query: "skin=cassette&time=64&lyrics=0", ...APP },
  { file: "remote-playing.jpg", page: "remote", query: "time=64", ...PHONE },
  {
    file: "remote-search.jpg",
    page: "remote",
    query: "time=64",
    ...PHONE,
    // Open Search and type a query; the stand-in answers with made-up songs.
    steps: async (page) => {
      await page.getByRole("button", { name: "Search" }).click();
      await page.getByLabel("Search songs").fill("night drive");
    },
  },
  // The app shows this over macOS's dark popover blur; capture it on that colour.
  { file: "menubar-player.jpg", page: "tray", query: "time=84", size: [320, 580], background: "#25252c" },
  { file: "immersive-apple.jpg", page: "immersive", query: "view=stage&skin=apple&time=64", ...MAC },
  { file: "immersive-nothing.jpg", page: "immersive", query: "view=stage&skin=nothing&time=64", ...MAC },
  { file: "immersive-vinyl.jpg", page: "immersive", query: "view=stage&skin=vinyl&time=64", ...MAC },
  { file: "immersive-lyrics.jpg", page: "immersive", query: "view=lyrics&skin=apple&time=64", ...MAC },
  // A portrait display (a 27" turned on its side): the artwork as a poster.
  { file: "immersive-portrait.jpg", page: "immersive", query: "view=art&skin=apple&time=64", size: [810, 1440], scale: 1100 / 810 },
];
const only = process.argv.slice(2);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
for (const s of shots.filter((s) => only.length === 0 || only.some((o) => s.file.includes(o)))) {
  const ctx = await browser.newContext({ viewport: { width: s.size[0], height: s.size[1] }, deviceScaleFactor: s.scale ?? 2, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/embed/${s.page}.html?${s.query}`, { waitUntil: "networkidle" });
  await page.waitForSelector("body[data-ready='1']", { timeout: 20_000 });
  if (s.background) await page.addStyleTag({ content: `html, body { background: ${s.background} !important; }` });
  if (s.steps) await s.steps(page);
  // Let artwork decode, the album colours settle and entrance animations finish.
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: OUT + s.file,
    type: s.file.endsWith(".png") ? "png" : "jpeg",
    quality: s.file.endsWith(".png") ? undefined : 88,
  });
  console.log(`captured ${s.file}`);
  await ctx.close();
}
await browser.close();
