import { useState, type FormEvent } from "react";
import { Globe, Link2, Lock } from "lucide-react";
import { createPlaylist, type PlaylistPrivacy } from "../../lib/playlists";

/** YouTube Music's limit on playlist names. */
const MAX_TITLE = 150;

const PRIVACY_CHOICES: Array<{ value: PlaylistPrivacy; label: string; icon: typeof Lock; hint: string }> = [
  { value: "PRIVATE", label: "Private", icon: Lock, hint: "Only you can see it" },
  { value: "UNLISTED", label: "Unlisted", icon: Link2, hint: "Anyone with the link" },
  { value: "PUBLIC", label: "Public", icon: Globe, hint: "Anyone can find it" },
];

interface NewPlaylistFormProps {
  /** Songs the new playlist starts with. */
  videoIds?: string[];
  submitLabel: string;
  onCreated: (playlist: { playlistId: string; title: string; privacy: PlaylistPrivacy }) => void;
  onCancel: () => void;
}

/** Name and privacy for a new playlist; creates it on YouTube Music when submitted. */
export function NewPlaylistForm({ videoIds = [], submitLabel, onCreated, onCancel }: NewPlaylistFormProps) {
  const [title, setTitle] = useState("");
  const [privacy, setPrivacy] = useState<PlaylistPrivacy>("PRIVATE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = title.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const playlistId = await createPlaylist(name, privacy, videoIds);
      onCreated({ playlistId, title: name, privacy });
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const hint = PRIVACY_CHOICES.find((c) => c.value === privacy)!.hint;

  return (
    <form className="new-playlist-form" onSubmit={(e) => void submit(e)}>
      <input
        autoFocus
        className="new-playlist-input"
        type="text"
        placeholder="Playlist name"
        aria-label="Playlist name"
        maxLength={MAX_TITLE}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
      />

      <div className="new-playlist-privacy" role="radiogroup" aria-label="Who can see it">
        {PRIVACY_CHOICES.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={privacy === value}
            className={`new-playlist-privacy-option ${privacy === value ? "is-on" : ""}`}
            onClick={() => setPrivacy(value)}
            disabled={busy}
          >
            <Icon size={13} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <p className={`new-playlist-hint ${error ? "is-error" : ""}`} role={error ? "alert" : undefined}>
        {error ?? hint}
      </p>

      <div className="new-playlist-actions">
        <button type="button" className="new-playlist-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="new-playlist-btn is-primary" disabled={!name || busy}>
          {busy ? "Creating…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
