import { Smartphone } from "lucide-react";
import { Modal } from "./Modal";
import { answerPairRequest, type PairRequest } from "../../lib/remote";

interface RemotePairModalProps {
  request: PairRequest;
  onDone: () => void;
}

/** A phone scanned the pairing code: allow it to control the app, or not. */
export function RemotePairModal({ request, onDone }: RemotePairModalProps) {
  const answer = (allow: boolean) => {
    void answerPairRequest(request.id, allow).catch(() => {});
    onDone();
  };
  return (
    <Modal
      title="Phone Remote"
      icon={<Smartphone size={18} strokeWidth={2} className="modal-title-icon" />}
      onClose={() => answer(false)}
      className="new-playlist-modal"
    >
      <p className="remote-pair-question">
        Allow <strong>{request.name}</strong> to control dot(.)music?
      </p>
      <p className="settings-desc">It will be able to play, skip and change Up Next until you disconnect it in Settings.</p>
      <div className="new-playlist-actions">
        <button type="button" className="new-playlist-btn" onClick={() => answer(false)}>
          Don't Allow
        </button>
        <button type="button" className="new-playlist-btn is-primary" onClick={() => answer(true)} autoFocus>
          Allow
        </button>
      </div>
    </Modal>
  );
}
