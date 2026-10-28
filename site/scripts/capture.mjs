// Captures the app's real UI (rendered by the dev-only pages in embed/) as the site's
// product shots. Run `npm run dev` first, then `npm run capture`. Needs Google Chrome.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.SITE_URL ?? "http://localhost:5810";
const OUT = new URL("../public/shots/", import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

const shots = [
  // The app shows this over macOS's dark popover blur; capture it on that colour.
  { file: "menubar-player.jpg", page: "tray", query: "time=84", size: [320, 580], background: "#25252c" },
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.size[0], height: s.size[1] }, deviceScaleFactor: 2, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/embed/${s.page}.html?${s.query}`, { waitUntil: "networkidle" });
  await page.waitForSelector("body[data-ready='1']", { timeout: 20_000 });
  if (s.background) await page.addStyleTag({ content: `html, body { background: ${s.background} !important; }` });
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
