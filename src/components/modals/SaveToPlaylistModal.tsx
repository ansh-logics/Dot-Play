import { useEffect, useMemo, useState } from "react";
import { Check, Globe, Link2, ListPlus, Lock, Plus, Search } from "lucide-react";
import { Modal } from "./Modal";
import { NewPlaylistForm } from "./NewPlaylistForm";
import { ArtworkImage } from "../ArtworkImage";
import { cleanDisplayTitle } from "../../lib/displayText";
import { getPlaylistsForSong, setSongInPlaylist, type PlaylistOption } from "../../lib/playlists";
import type { SearchResult } from "../../lib/search";

/** Past this many playlists the picker gets a search box. */
const SEARCH_FROM = 7;

const PRIVACY = {
  PUBLIC: { icon: Globe, label: "Public" },
  UNLISTED: { icon: Link2, label: "Unlisted" },
  PRIVATE: { icon: Lock, label: "Private" },
} as const;

interface SaveToPlaylistModalProps {
  track: SearchResult;
  onClose: () => void;
  showToast: (message: string) => void;
  /** A playlist was created here; the Library list should pick it up. */
  onPlaylistCreated: () => void;
}

/**
 * Save a song to any of the user's playlists. Each row is a toggle: a tick means the song is
 * in that playlist, and clicking again takes it out. Changes apply at once and roll back if
 * YouTube Music refuses.
 */
export function SaveToPlaylistModal({ track, onClose, showToast, onPlaylistCreated }: SaveToPlaylistModalProps) {
  const [playlists, setPlaylists] = useState<PlaylistOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPlaylistsForSong(track.videoId)
      .then((list) => !cancelled && setPlaylists(list))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [track.videoId]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q && playlists ? playlists.filter((p) => p.title.toLowerCase().includes(q)) : playlists;
  }, [playlists, query]);

  const setContains = (playlistId: string, contains: boolean) =>
    setPlaylists((list) => list?.map((p) => (p.playlistId === playlistId ? { ...p, contains } : p)) ?? null);

  const toggle = async (playlist: PlaylistOption) => {
    if (pending.has(playlist.playlistId)) return;
    const add = !playlist.contains;
    setContains(playlist.playlistId, add);
    setPending((s) => new Set(s).add(playlist.playlistId));
    try {
      await setSongInPlaylist(playlist.playlistId, track.videoId, add);
      showToast(add ? `Saved to ${playlist.title}` : `Removed from ${playlist.title}`);
    } catch {
      setContains(playlist.playlistId, !add);
      showToast(`Couldn't update ${playlist.title}. Try again.`);
    } finally {
      setPending((s) => {
        const next = new Set(s);
        next.delete(playlist.playlistId);
        return next;
      });
    }
  };

  return (
    <Modal
      title="Save to Playlist"
      icon={<ListPlus size={18} strokeWidth={2} className="modal-title-icon" />}
      onClose={onClose}
      className="save-playlist-modal"
    >
      <div className="save-playlist-song">
        <ArtworkImage
          src={track.thumbnailUrl}
          videoId={track.videoId}
          alt=""
          className="save-playlist-art"
          variant="thumbnail"
        />
        <div className="save-playlist-song-text">
          <span className="save-playlist-song-title">{cleanDisplayTitle(track.title)}</span>
          <span className="save-playlist-song-artist">{track.artist}</span>
        </div>
      </div>

      {creating ? (
        <NewPlaylistForm
          videoIds={[track.videoId]}
          submitLabel="Create and Save"
          onCancel={() => setCreating(false)}
          onCreated={({ playlistId, title, privacy }) => {
            setPlaylists((list) => [{ playlistId, title, privacy, contains: true }, ...(list ?? [])]);
            setQuery("");
            setCreating(false);
            showToast(`Created ${title} and saved the song`);
            onPlaylistCreated();
          }}
        />
      ) : (
        <>
          {playlists && playlists.length >= SEARCH_FROM && (
            <label className="save-playlist-search">
              <Search size={15} aria-hidden="true" />
              <input
                autoFocus
                type="text"
                placeholder="Find a playlist"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Find a playlist"
              />
            </label>
          )}

          <div className="save-playlist-list" role="list" aria-busy={!playlists && !error}>
            {!error && (
              <button type="button" className="save-playlist-row is-new" onClick={() => setCreating(true)}>
                <span className="save-playlist-check" aria-hidden="true">
                  <Plus size={13} strokeWidth={2.5} />
                </span>
                <span className="save-playlist-name">New Playlist</span>
              </button>
            )}
            {error ? (
              <p className="save-playlist-note">Couldn't load your playlists. {error}</p>
            ) : !shown ? (
              Array.from({ length: 4 }, (_, i) => <div key={i} className="save-playlist-row is-skeleton" />)
            ) : shown.length === 0 ? (
              // With no playlists at all, the New Playlist row above says enough.
              query.trim() && <p className="save-playlist-note">No playlist matches “{query.trim()}”.</p>
            ) : (
              shown.map((playlist) => {
                const privacy = playlist.privacy ? PRIVACY[playlist.privacy] : null;
                return (
                  <button
                    key={playlist.playlistId}
                    type="button"
                    role="listitem"
                    className={`save-playlist-row ${playlist.contains ? "is-in" : ""}`}
                    onClick={() => void toggle(playlist)}
                    aria-pressed={playlist.contains}
                  >
                    <span className="save-playlist-check" aria-hidden="true">
                      {playlist.contains && <Check size={13} strokeWidth={3} />}
                    </span>
                    <span className="save-playlist-name">{playlist.title}</span>
                    {privacy && (
                      <span className="save-playlist-privacy" title={privacy.label} aria-label={privacy.label}>
                        <privacy.icon size={13} />
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
