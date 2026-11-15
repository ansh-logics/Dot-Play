export function Wordmark() {
  return (
    <h1 className="tv-wordmark">
      dot<span>(.)</span>play
    </h1>
  )
}

/** Shown until a desktop app links this TV: the code it needs, and where to type it. */
export function LinkScreen({ name, code }: { name: string; code: string }) {
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
