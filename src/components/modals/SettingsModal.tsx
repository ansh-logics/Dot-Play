import { Settings } from "lucide-react";
import { Modal } from "./Modal";
import type { FeedbackPrefs } from "../../lib/feedback";

interface SettingsModalProps {
  feedbackPrefs: FeedbackPrefs;
  onFeedbackChange: (patch: Partial<FeedbackPrefs>) => void;
  isLoggedIn: boolean;
  accountEmail: string | undefined;
  onSignOut: () => void;
  onClose: () => void;
}

interface SwitchRowProps {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}

function SwitchRow({ label, description, checked, onToggle }: SwitchRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-label">{label}</span>
        <span className="settings-desc">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`settings-switch ${checked ? "on" : ""}`}
        onClick={onToggle}
      >
        <span className="settings-switch-knob" />
      </button>
    </div>
  );
}

function clearArtworkCache() {
  localStorage.removeItem("dot_verified_artwork_cache");
  localStorage.removeItem("dot_music_track_metadata_cache");
  window.location.reload();
}

export function SettingsModal({
  feedbackPrefs,
  onFeedbackChange,
  isLoggedIn,
  accountEmail,
  onSignOut,
  onClose,
}: SettingsModalProps) {
  return (
    <Modal
      title="Settings"
      icon={<Settings size={18} strokeWidth={2} className="modal-title-icon" />}
      onClose={onClose}
    >
      <div className="settings-section">
        <span className="settings-section-title">AUDIO ENGINE</span>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">Stream Quality</span>
            <span className="settings-desc">High Definition WebM/Opus audio streaming</span>
          </div>
          <span className="settings-badge">256 KBPS</span>
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">PLAYER</span>
        <SwitchRow
          label="Wheel click sound"
          description="A soft click on each notch of the player-style wheel"
          checked={feedbackPrefs.sound}
          onToggle={() => onFeedbackChange({ sound: !feedbackPrefs.sound })}
        />
        <SwitchRow
          label="Trackpad haptics"
          description="Feel each notch on a Force Touch trackpad"
          checked={feedbackPrefs.haptics}
          onToggle={() => onFeedbackChange({ haptics: !feedbackPrefs.haptics })}
        />
      </div>

      <div className="settings-section">
        <span className="settings-section-title">DATA & STORAGE</span>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">Track & Artwork Cache</span>
            <span className="settings-desc">Optimized WebP local cache for fast loading</span>
          </div>
          <button type="button" className="settings-action-btn" onClick={clearArtworkCache}>
            Clear Cache
          </button>
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">ACCOUNT</span>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">Status</span>
            <span className="settings-desc">
              {isLoggedIn ? accountEmail || "Connected to YouTube Music" : "Offline (Guest Mode)"}
            </span>
          </div>
          {isLoggedIn ? (
            <button
              type="button"
              className="settings-action-btn"
              onClick={() => {
                onClose();
                onSignOut();
              }}
              style={{ color: "var(--red-primary, #ff0055)" }}
            >
              Sign Out
            </button>
          ) : (
            <span className="settings-status-pill offline">OFFLINE</span>
          )}
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">ABOUT</span>
        <div className="settings-about-box">
          <span className="about-app-name">dot(.)music</span>
          <span className="about-app-ver">Version {__APP_VERSION__} • Nothing OS Minimalist Design</span>
        </div>
      </div>
    </Modal>
  );
}
