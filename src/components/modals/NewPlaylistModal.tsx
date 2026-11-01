import { ListPlus } from "lucide-react";
import { Modal } from "./Modal";
import { NewPlaylistForm } from "./NewPlaylistForm";

interface NewPlaylistModalProps {
  onClose: () => void;
  onCreated: (playlistId: string, title: string) => void;
}

/** Creates an empty playlist from the Library page. */
export function NewPlaylistModal({ onClose, onCreated }: NewPlaylistModalProps) {
  return (
    <Modal
      title="New Playlist"
      icon={<ListPlus size={18} strokeWidth={2} className="modal-title-icon" />}
      onClose={onClose}
      className="new-playlist-modal"
    >
      <NewPlaylistForm
        submitLabel="Create"
        onCancel={onClose}
        onCreated={({ playlistId, title }) => onCreated(playlistId, title)}
      />
    </Modal>
  );
}
