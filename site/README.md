# dot(.)music website

The product site for dot(.)music: features, download and GitHub links, and screenshots of the
app's real UI.
It's a standalone Vite + React app next to the Tauri app.

```bash
cd site
npm install
npm run dev        # http://localhost:5810
npm run build      # → site/dist
```

## How it's put together

A plain React page with screenshots of the **real app** and simple Apple-style motion. The hero
shot settles from a tilt, the three styles cross-fade, the vinyl slowly pushes in, a highlight
sweeps the lyrics headline, and the menu bar player drops from its icon.

- `src/sections/`: Nav, Hero, Showcase (styles, lyrics, vinyl, menu bar, queue), Built light,
  Install, FAQ and Footer.
- `public/shots/`: the product screenshots.
- `src/lib/github.ts`: the live star count and the latest release, with plain-link fallbacks.

### Updating the screenshots

The Now Playing, queue and home shots in `public/shots/app-*.jpg` are screenshots of the app.
The menu bar shot is captured
from the app's actual React components:

```bash
npm run dev       # serves the dev-only capture pages in embed/
npm run capture   # → public/shots/*.jpg (needs Google Chrome)
```

- `embed/nowplaying.html` and `embed/tray.html` render the app's `NowPlaying` and menu bar
  `TrayPlayer` from `../src`. The state comes from the URL, e.g. `?skin=vinyl&time=120`.
- `src/embed/tauriMock.ts` stands in for `@tauri-apps/api` in the browser.
- `src/embed/song.ts` defines the featured song. Its cover comes from the iTunes Search API
  when you capture.
- Captures leave the lyrics panel closed.
- These pages are only used for capturing and aren't part of the deployed site.

## Social preview

`public/og.png` is the social preview image.

## Deploy (Vercel)

1. Import the GitHub repo in Vercel.
2. Set **Root Directory** to `site`. The framework (Vite), the build command and the `dist` output are detected automatically.
3. Every push to `main` redeploys the site.
