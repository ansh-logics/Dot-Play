import { useRef } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "../../lib/a11y";

interface ModalProps {
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  /** Extra class on the card, for dialogs that need their own width or layout. */
  className?: string;
}

/** Nothing-style dialog shell; clicking the backdrop closes it. Focus stays inside while open. */
export function Modal({ title, icon, onClose, children, className = "" }: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useDialogFocus(cardRef);
  return (
    <div className="nothing-modal-backdrop" onClick={onClose}>
      <div
        ref={cardRef}
        className={`nothing-modal-card ${className}`}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nothing-modal-header">
          <div className="nothing-modal-title-row">
            {icon}
            <h3 className="nothing-modal-title">{title}</h3>
          </div>
          <button type="button" className="nothing-modal-close-btn" onClick={onClose} aria-label="Close" data-dialog-close>
            <X size={18} />
          </button>
        </div>
        <div className="nothing-modal-body">{children}</div>
      </div>
    </div>
  );
}
