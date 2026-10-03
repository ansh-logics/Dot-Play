# DOT Music

DOT Music is a minimal React + TypeScript learning project demonstrating how a custom frontend music interface controls a hidden YouTube iframe player.

## Learning Architecture

```text
User pastes YouTube URL
  ↓
React parses video ID locally (no network call)
  ↓
React fetches public metadata via YouTube oEmbed (no API key)
  ↓
If metadata exists, mount hidden YouTube iframe player
  ↓
React owns all visible UI (title, thumbnail, controls, seek bar)
  ↓
YouTube iframe owns media playback & stream state
  ↓
Iframe events (ready, stateChange, error) update React state
```

## Boundaries

- **React owns:** URL input, metadata display, play/pause trigger, seek slider, duration/time formatting, error states.
- **Hidden iframe owns:** Audio streaming, decoding, playback position, and true playback status (`playing`, `paused`, `ended`, `buffering`).
- **No shortcuts:** React does not assume playback succeeds when the user clicks Play. It waits for the iframe's `onStateChange` event.
- **Embedding restrictions:** Certain videos (errors `101` and `150`) cannot be embedded by owner choice. DOT Music treats this as a genuine playback error.

## Completed Learning Steps

1. **Parse URL to Video ID (`src/lib/youtube.ts`):**
   - Validates input locally with RegExp and URL parsing (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`, or raw 11-char ID).
   - Fails fast before making any network request.

2. **Validate & Fetch Metadata (`src/lib/youtube.ts`):**
   - Calls YouTube's public oEmbed endpoint (`https://www.youtube.com/oembed`).
   - Retrieves track title, author name, and thumbnail without requiring a YouTube Data API v3 key.
   - Note: oEmbed does not provide duration; duration comes from the iframe player once initialized.

3. **Hidden Iframe Controlled by React (`src/components/HiddenYouTubePlayer.tsx` & `src/App.tsx`):**
   - Loads the YouTube Iframe API script dynamically (`https://www.youtube.com/iframe_api`).
   - Instantiates a hidden DOM element (`aria-hidden="true"`, offscreen) with `controls: 0` and `enablejsapi: 1`.
   - React sends imperative commands via a ref (`playVideo()`, `pauseVideo()`, `seekTo()`).
   - The iframe sends event callbacks back to React (`onReady`, `onStateChange`, `onError`).
   - React polls `player.getCurrentTime()` and `player.getDuration()` to reconcile the seek slider.

4. **Search Service & Track Selection (`src/lib/search.ts` & `src/App.tsx`):**
   - Standardized `SearchResult` contract decoupling UI from data transport.
   - Dual-mode input: automatically distinguishes between direct YouTube URLs and keyword searches.
   - Official YouTube Data API v3 provider (with `videoEmbeddable=true`) when `VITE_YOUTUBE_API_KEY` is present.
   - Built-in curated catalog fallback for immediate local testing without an API key.
   - Clicking any result card immediately triggers metadata selection and begins playback.

5. **Tauri Native Backend Search (`src-tauri/` & `src/lib/search.ts`):**
   - Native Rust backend using `reqwest` to query YouTube search without browser CORS limitations.
   - Rust command `search_tracks` parses InnerTube results and serializes them into the `SearchResult` struct.
   - React detects when running inside Tauri via `window.__TAURI_INTERNALS__` and invokes the native command.
   - Preserves complete backward compatibility: still runs smoothly in standard web browsers!

6. **YouTube Music Login & Home Feed Recommendations (`src-tauri/` & `src/App.tsx`):**
   - Native Google/YouTube Music login popup (`open_login_window`) with Safari desktop user-agent to bypass Google's webview lock.
   - Listens to navigation redirecting to `https://music.youtube.com`, captures session cookies, and saves session.
   - Implements `SAPISIDHASH` SHA-1 authentication required by YouTube for logged-in InnerTube API requests.
   - Fetches personalized Home recommendation shelves (`FEmusic_home`) and renders playable track/playlist cards.

## Development

```bash
npm install
npm run dev        # Run React in browser (http://127.0.0.1:5173)
npm run tauri dev  # Run as native desktop app with Rust backend
npm run build      # Type-check and production frontend build
```
