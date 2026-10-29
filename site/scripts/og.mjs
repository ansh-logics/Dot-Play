// Renders scripts/og.html (the social preview card) to public/og.png at 1200×630.
// Run `npm run dev` first, then `npm run og`. Needs Google Chrome.
import { chromium } from "playwright-core";

const BASE = process.env.SITE_URL ?? "http://localhost:5810";
const OUT = new URL("../public/og.png", import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--force-color-profile=srgb"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`${BASE}/scripts/og.html`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: OUT, type: "png" });
await browser.close();
console.log("rendered public/og.png");
