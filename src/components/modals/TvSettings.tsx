import { useEffect, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { Tv } from "lucide-react";
import { forgetTv, getTvs, pairTv, type TvStatus } from "../../lib/tvs";
import { isTauriEnvironment } from "../../lib/search";

/** Settings → TVs: TVs found on this network, linking one with its code, and the linked TVs. */
export function TvSettings() {
  const [status, setStatus] = useState<TvStatus | null>(null);
  /** The TV being linked: its address, or "manual" while an address is typed by hand. */
  const [target, setTarget] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const refresh = () => void getTvs().then(setStatus, () => {});
    refresh();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // A TV turning on or off, linking or signing out changes what's listed.
    void listen("tvs-changed", refresh).then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!status) return null;

  const start = (next: string) => {
    setTarget(next);
    setCode("");
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await pairTv(target === "manual" ? address : target, code));
      setTarget(null);
      setAddress("");
      setCode("");
    } catch (err) {
      setError(String(err));
      // The TV replaces its code after every attempt.
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const pairForm = (
    <form className="tv-pair-form" onSubmit={(e) => void submit(e)}>
      {target === "manual" && (
        <input
          className="new-playlist-input"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="TV's IP address, e.g. 192.168.1.20"
          aria-label="TV's IP address"
          autoFocus
        />
      )}
      <input
        className="new-playlist-input tv-pair-code"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="Code on the TV"
        aria-label="Six-digit code shown on the TV"
        inputMode="numeric"
        autoComplete="off"
        autoFocus={target !== "manual"}
      />
      <button
        type="submit"
        className="settings-action-btn"
        disabled={busy || code.length !== 6 || (target === "manual" && !address.trim())}
      >
        {busy ? "Linking…" : "Link"}
      </button>
      <button type="button" className="settings-action-btn" onClick={() => setTarget(null)} disabled={busy}>
        Cancel
      </button>
    </form>
  );

  return (
    <div className="settings-section">
      <span className="settings-section-title">TVS</span>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-label">Play on your TV</span>
          <span className="settings-desc">
            Install dot(.)play on an Android TV on the same Wi-Fi, then link it with the code it shows. The TV signs
            in with your account from here; nothing is typed on the TV.
          </span>
        </div>
      </div>
      {error && (
        <p className="remote-settings-error" role="alert">
          {error}
        </p>
      )}

      {status.linked.length > 0 && (
        <ul className="remote-devices">
          {status.linked.map((tv) => (
            <li key={tv.id} className="settings-row">
              <div className="remote-device-name">
                <Tv size={15} />
                <span className="settings-label">{tv.name}</span>
                <span className="settings-desc">{tv.online ? "Connected" : "Off or out of reach"}</span>
              </div>
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => void forgetTv(tv.id).then(setStatus, () => {})}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}

      <ul className="remote-devices">
        {status.nearby.map((tv) => (
          <li key={tv.address} className="settings-row tv-nearby-row">
            <div className="remote-device-name">
              <Tv size={15} />
              <span className="settings-label">{tv.name}</span>
              <span className="settings-desc">On this network</span>
            </div>
            {target === tv.address ? (
              pairForm
            ) : (
              <button type="button" className="settings-action-btn" onClick={() => start(tv.address)}>
                Link
              </button>
            )}
          </li>
        ))}
        <li className="settings-row tv-nearby-row">
          <div className="settings-row-text">
            <span className="settings-desc">
              {status.nearby.length === 0 && status.linked.length === 0
                ? "No TVs found yet. Open dot(.)play on the TV."
                : "TV not listed?"}
            </span>
          </div>
          {target === "manual" ? (
            pairForm
          ) : (
            <button type="button" className="settings-action-btn" onClick={() => start("manual")}>
              Add by address
            </button>
          )}
        </li>
      </ul>
    </div>
  );
}
