import { HelpCircle } from "lucide-react";
import { Modal } from "./Modal";

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["Space"], label: "Play / Pause" },
  { keys: ["←", "→"], label: "Seek -5s / +5s" },
  { keys: ["/"], label: "Focus Search" },
  { keys: ["Esc"], label: "Dismiss Popups & Modals" },
];

export function SupportModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="SUPPORT & SHORTCUTS"
      icon={<HelpCircle size={18} strokeWidth={2} className="modal-title-icon" />}
      onClose={onClose}
    >
      <div className="settings-section">
        <span className="settings-section-title">KEYBOARD SHORTCUTS</span>
        <div className="shortcuts-grid">
          {SHORTCUTS.map(({ keys, label }) => (
            <div key={label} className="shortcut-item">
              {keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">HELP & COMMUNITY</span>
        <p className="support-desc">
          dot(.)music is a lightweight desktop client for YouTube Music built with Tauri and React,
          featuring an OLED-black aesthetic.
        </p>
        <div className="support-links">
          <a
            href="https://music.youtube.com"
            target="_blank"
            rel="noreferrer"
            className="support-link-btn"
          >
            Open YouTube Music Web
          </a>
        </div>
      </div>
    </Modal>
  );
}
