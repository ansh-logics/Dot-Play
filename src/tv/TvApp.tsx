import { useEffect, useRef, useState } from "react"
import { usePlayer } from "./usePlayer"

/**
 * Phase 0 test screen: proves the player autoplays in the TV's WebView, that the remote's
 * keys arrive, and shows how much memory the page takes. The real screens replace it.
 */

const TEST_VIDEO = "M7lc1UVf-VE"

interface MemoryInfo {
  usedJSHeapSize: number
  totalJSHeapSize: number
}

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function TvApp() {
  const player = usePlayer()
  const { snapshot } = player
  const [keys, setKeys] = useState<string[]>([])
  const [heap, setHeap] = useState("")
  const loadedRef = useRef(false)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  // Autoplay with no key pressed: the thing a receiver has to be able to do.
  useEffect(() => {
    if (snapshot.state === "ready" && !loadedRef.current) {
      loadedRef.current = true
      player.load(TEST_VIDEO)
    }
  }, [snapshot.state, player])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      setKeys((list) => [`${event.key} (${event.keyCode})`, ...list].slice(0, 6))
      const now = snapshotRef.current
      if (event.key === "Enter" || event.key === "MediaPlayPause" || event.key === " ") {
        if (now.state === "playing") player.pause()
        else player.play()
      } else if (event.key === "ArrowRight" || event.key === "MediaFastForward") {
        player.seek(now.currentTime + 10)
      } else if (event.key === "ArrowLeft" || event.key === "MediaRewind") {
        player.seek(now.currentTime - 10)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [player])

  useEffect(() => {
    const timer = setInterval(() => {
      const memory = (performance as Performance & { memory?: MemoryInfo }).memory
      if (memory) setHeap(`${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB`)
    }, 2000)
    return () => clearInterval(timer)
  }, [])

  return (
    <main className="tv">
      <h1>
        dot<span>(.)</span>play
      </h1>
      <p className="tv-sub">TV test screen</p>
      <dl className="tv-facts">
        <dt>Player</dt>
        <dd data-testid="state">
          {snapshot.state}
          {snapshot.errorCode !== null ? ` (error ${snapshot.errorCode})` : ""}
        </dd>
        <dt>Time</dt>
        <dd data-testid="time">
          {clock(snapshot.currentTime)} / {clock(snapshot.duration)}
        </dd>
        <dt>Volume</dt>
        <dd>{snapshot.volume}</dd>
        <dt>Screen</dt>
        <dd>
          {window.innerWidth}×{window.innerHeight} @{window.devicePixelRatio}
        </dd>
        <dt>Page memory</dt>
        <dd>{heap || "n/a"}</dd>
        <dt>Keys</dt>
        <dd data-testid="keys">{keys.join("  ·  ") || "press a button on the remote"}</dd>
      </dl>
      <p className="tv-hint">OK: play / pause · Left and Right: seek 10 s</p>
      {player.src && (
        <iframe
          ref={player.iframeRef}
          className="tv-engine"
          src={player.src}
          title="Audio engine"
          allow="autoplay; encrypted-media"
          tabIndex={-1}
        />
      )}
    </main>
  )
}
