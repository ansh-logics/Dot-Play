import { Heart } from "lucide-react";
import { useLikeStatus } from "../lib/likes";

interface LikeButtonProps {
  videoId: string;
  /** Signed in: like states are fetched and shown. Signed out the heart stays empty. */
  enabled: boolean;
  onToggle: () => void;
  className: string;
  size: number;
}

/** A heart that fills when the song is in the user's Liked Music. */
export function LikeButton({ videoId, enabled, onToggle, className, size }: LikeButtonProps) {
  const liked = useLikeStatus(videoId, enabled) === "LIKE";
  const label = liked ? "Remove from Liked Music" : "Add to Liked Music";
  return (
    <button
      type="button"
      className={`${className} like-btn ${liked ? "is-liked" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={liked}
      aria-label={label}
      title={label}
    >
      <Heart size={size} fill={liked ? "currentColor" : "none"} />
    </button>
  );
}
