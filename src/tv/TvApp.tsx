import { useEffect, useState } from "react"
import { useLink } from "./useLink"
import { usePlayer, type PlayerSnapshot } from "./usePlayer"
import { useReceiver, type NowShowing } from "./useReceiver"

/**
 * The TV's screens: "link this TV" (the code a desktop app needs), the home screen once it is
 * linked, and now playing while a desktop plays here. The player itself is always mounted.
 */
export function TvApp() {
  const { link, profile, signOut } = useLink()
  const player = usePlayer()
  const { now } = useReceiver(player)

  return (
    <>
      {!link ? (
        <main className="tv" />
      ) : link.linked.length === 0 ? (
        <LinkScreen name={link.name} code={link.code} />
      ) : now?.track ? (
        <NowPlayingScreen now={now} snapshot={player.snapshot} />
      ) : (
        <HomeScreen link={link} profile={profile} onSignOut={signOut} />
      )}
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
    </>
  )
}

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function NowPlayingScreen({ now, snapshot }: { now: NowShowing; snapshot: PlayerSnapshot }) {
  const track = now.track!
  const progress = snapshot.duration > 0 ? Math.min(1, snapshot.currentTime / snapshot.duration) : 0
  const status =
    snapshot.state === "paused" || snapshot.state === "cued"
      ? "Paused"
      : snapshot.state === "playing"
        ? null
        : snapshot.state === "ended"
          ? null
          : "Loading…"

  return (
    <main className="tv tv-now">
      <div className="tv-now-main">
        {track.thumb ? <img className="tv-art" src={track.thumb} alt="" referrerPolicy="no-referrer" /> : <div className="tv-art" />}
        <div className="tv-now-text">
          <Wordmark />
          <h2>{track.title}</h2>
          <p className="tv-artist">{track.artist}</p>
          {status && <p className="tv-now-status">{status}</p>}
        </div>
      </div>

      <div className="tv-progress">
        <span>{clock(snapshot.currentTime)}</span>
        <div className="tv-progress-track">
          <div className="tv-progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <span>{snapshot.duration > 0 ? clock(snapshot.duration) : "–:––"}</span>
      </div>

      {now.upcoming.length > 0 && (
        <p className="tv-next">
          <span>Next</span>
          {now.upcoming[0].title} · {now.upcoming[0].artist}
        </p>
      )}
    </main>
  )
}

function Wordmark() {
  return (
    <h1 className="tv-wordmark">
      dot<span>(.)</span>play
    </h1>
  )
}

function LinkScreen({ name, code }: { name: string; code: string }) {
  return (
    <main className="tv tv-link">
      <Wordmark />
      <div className="tv-link-body">
        <div className="tv-link-steps">
          <h2>Link this TV</h2>
          <ol>
            <li>Open dot(.)music on your computer, on the same Wi-Fi as this TV.</li>
            <li>
              Go to Settings, then TVs, and choose <strong>{name}</strong>.
            </li>
            <li>Type this code.</li>
          </ol>
        </div>
        <div className="tv-code" aria-label={`Code ${code.split("").join(" ")}`}>
          {code.split("").map((digit, index) => (
            <span key={index}>{digit}</span>
          ))}
        </div>
      </div>
      <p className="tv-footnote">Your account is sent from your computer, encrypted. Nothing is typed on the TV.</p>
    </main>
  )
}

interface HomeProps {
  link: { name: string; linked: Array<{ id: string; name: string }>; online: string[]; signedIn: boolean }
  profile: { name: string; avatarUrl: string } | null
  onSignOut: () => void
}

function HomeScreen({ link, profile, onSignOut }: HomeProps) {
  // Signing out takes two presses of OK, so a stray press doesn't do it.
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 5000)
    return () => clearTimeout(timer)
  }, [confirming])

  const connected = link.linked.filter((desktop) => link.online.includes(desktop.id))
  const status =
    connected.length > 0
      ? `Connected to ${connected.map((d) => d.name).join(", ")}`
      : `Linked to ${link.linked.map((d) => d.name).join(", ")} · not connected right now`

  return (
    <main className="tv tv-home">
      <header className="tv-home-top">
        <Wordmark />
        <div className="tv-account">
          {profile?.avatarUrl && <img src={profile.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <span>{link.signedIn ? (profile?.name ?? "Signed in") : "Not signed in"}</span>
        </div>
      </header>

      <section className="tv-ready">
        <h2>Ready to play</h2>
        <p>Choose {link.name} in dot(.)music on your computer to play here.</p>
        <p className={`tv-status ${connected.length > 0 ? "is-on" : ""}`}>
          <span className="tv-status-dot" />
          {status}
        </p>
        {!link.signedIn && (
          <p className="tv-note">Sign in to dot(.)music on your computer and this TV signs in with it.</p>
        )}
      </section>

      <button
        type="button"
        className="tv-button"
        autoFocus
        onClick={() => {
          if (confirming) onSignOut()
          else setConfirming(true)
        }}
      >
        {confirming ? "Press OK again to sign out" : "Sign out of this TV"}
      </button>
    </main>
  )
}
