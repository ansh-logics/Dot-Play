import { useEffect, useState } from "react"
import { useLink } from "./useLink"

/**
 * The TV's two screens so far: "link this TV" (the code a desktop app needs) and the home
 * screen once it is linked. Playback from the desktop comes next and lands on the home screen.
 */
export function TvApp() {
  const { link, profile, signOut } = useLink()

  if (!link) return <main className="tv" />
  return link.linked.length === 0 ? (
    <LinkScreen name={link.name} code={link.code} />
  ) : (
    <HomeScreen link={link} profile={profile} onSignOut={signOut} />
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
