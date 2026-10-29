import { X } from "lucide-react";

interface ModalProps {
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

/** Nothing-style dialog shell; clicking the backdrop closes it. */
export function Modal({ title, icon, onClose, children }: ModalProps) {
  return (
    <div className="nothing-modal-backdrop" onClick={onClose}>
      <div className="nothing-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="nothing-modal-header">
          <div className="nothing-modal-title-row">
            {icon}
            <h3 className="nothing-modal-title">{title}</h3>
          </div>
          <button type="button" className="nothing-modal-close-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="nothing-modal-body">{children}</div>
      </div>
    </div>
  );
}
