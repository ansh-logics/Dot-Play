import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Smartphone } from "lucide-react";
import { forgetRemoteDevice, getRemoteStatus, setRemoteEnabled, type RemoteStatus } from "../../lib/remote";
import { isTauriEnvironment } from "../../lib/search";

/** Settings → Phone Remote: the switch, the pairing QR code and the paired phones. */
export function PhoneRemoteSettings() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const refresh = () => void getRemoteStatus().then(setStatus, () => {});
    refresh();
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const keep = (fn: () => void) => (disposed ? fn() : unlisteners.push(fn));
    // A new phone, or one connecting or leaving, changes what's listed.
    void listen("remote-devices-changed", refresh).then(keep);
    void listen("remote-clients", refresh).then(keep);
    void listen("remote-status-changed", refresh).then(keep);
    // The Mac's Wi-Fi address can change (reconnecting, a new network); keep the QR current.
    const timer = window.setInterval(refresh, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  if (!status) return null;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await setRemoteEnabled(!status.enabled));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!status.url) return;
    void navigator.clipboard.writeText(status.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="settings-section">
      <span className="settings-section-title">PHONE REMOTE</span>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-label">Control from your phone</span>
          <span className="settings-desc">
            Play, skip, lyrics and Up Next in your phone's browser, on any Wi-Fi or mobile data. Everything is
            end-to-end encrypted.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={status.enabled}
          className={`settings-switch ${status.enabled ? "on" : ""}`}
          onClick={() => void toggle()}
          disabled={busy || (status.relay === "unconfigured" && !status.enabled)}
        >
          <span className="settings-switch-knob" />
        </button>
      </div>
      {error && <p className="remote-settings-error">{error}</p>}
      {status.relay === "unconfigured" && (
        <p className="remote-settings-error">The Phone Remote isn't available in this build yet.</p>
      )}
      {status.enabled && status.relay !== "unconfigured" && (
        <p className={`remote-relay-status is-${status.relay}`}>
          <span className="remote-relay-dot" />
          {status.relay === "online"
            ? status.clients > 0
              ? `Connected · ${status.clients} ${status.clients === 1 ? "phone" : "phones"} active`
              : "Connected · ready for your phone"
            : status.relay === "connecting"
              ? "Connecting…"
              : "Offline · check your internet connection"}
        </p>
      )}

      {status.enabled && (
        <div className="remote-pair-card">
          {status.qrSvg ? (
            <div className="remote-qr" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: status.qrSvg }} />
          ) : (
            <div className="remote-qr is-empty">Unavailable</div>
          )}
          <div className="remote-pair-text">
            <span className="settings-label">Scan with your phone's camera</span>
            <span className="settings-desc">
              Your Mac will ask before a new phone can connect. Each code works once; a new one appears after
              pairing.
            </span>
            {status.url && (
              <button type="button" className="settings-action-btn remote-copy-btn" onClick={copy}>
                {copied ? "Copied" : "Copy Link"}
              </button>
            )}
          </div>
        </div>
      )}

      {status.devices.length > 0 && (
        <ul className="remote-devices">
          {status.devices.map((device) => (
            <li key={device.id} className="settings-row">
              <div className="remote-device-name">
                <Smartphone size={15} />
                <span className="settings-label">{device.name}</span>
                <span className="settings-desc">
                  Paired {new Date(device.pairedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
              </div>
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => void forgetRemoteDevice(device.id).then(setStatus, () => {})}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
