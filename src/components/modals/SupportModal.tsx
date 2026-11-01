import { HelpCircle } from "lucide-react";
import { Modal } from "./Modal";
import { SHORTCUT_GROUPS } from "../../lib/shortcuts";

export function SupportModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Support & Shortcuts"
      icon={<HelpCircle size={18} strokeWidth={2} className="modal-title-icon" />}
      onClose={onClose}
    >
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} className="settings-section">
          <span className="settings-section-title">{group.title}</span>
          <div className="shortcuts-grid">
            {group.items.map(({ keys, label }) => (
              <div key={label} className="shortcut-item">
                {keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

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
