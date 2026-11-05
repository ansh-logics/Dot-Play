// Renders slides.html into images/. Run from the repo root: node marketing/v1.3/render.mjs
// Uses the site's playwright-core and Google Chrome.
import { createRequire } from "node:module";

const require = createRequire(new URL("../../site/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const HERE = new URL(".", import.meta.url).pathname;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SLIDES = [
  ["ig-1", 1080, 1350],
  ["ig-2", 1080, 1350],
  ["ig-3", 1080, 1350],
  ["ig-4", 1080, 1350],
  ["ig-5", 1080, 1350],
  ["x-cassette", 1600, 900],
  ["x-remote", 1600, 900],
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--allow-file-access-from-files", "--force-color-profile=srgb"] });
for (const [id, width, height] of SLIDES) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`file://${HERE}slides.html?s=${id}`);
  await page.waitForSelector("body[data-ready='1']", { timeout: 20_000 });
  await page.waitForTimeout(300);
  await page.locator(`#${id}`).screenshot({ path: `${HERE}images/${id}.jpg`, type: "jpeg", quality: 92 });
  console.log(`rendered ${id}.jpg`);
  await page.close();
}
await browser.close();
