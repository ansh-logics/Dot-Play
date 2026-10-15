import { X } from "lucide-react";
import { command, type TrayQueueItem } from "./types";

interface QueueViewProps {
  upcoming: TrayQueueItem[];
  autoplay: boolean;
}

/** Up Next: tap a song to play it, × to take it out of the queue. */
export function QueueView({ upcoming, autoplay }: QueueViewProps) {
  if (upcoming.length === 0) {
    return (
      <div className="tray-panel tray-panel--empty">
        <p className="tray-panel-empty-title">Queue is empty</p>
        {autoplay && <p className="tray-panel-empty-sub">Autoplay will keep the music going</p>}
      </div>
    );
  }

  return (
    <div className="tray-panel">
      <p className="tray-panel-heading">Up Next</p>
      <ul className="tray-queue">
        {upcoming.map((item, index) => (
          <li key={`${item.videoId}-${index}`}>
            <button
              type="button"
              className="tray-queue-item"
              onClick={() => command({ type: "playQueueItem", videoId: item.videoId })}
            >
              <span className="tray-queue-art">
                {item.thumb && <img src={item.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />}
              </span>
              <span className="tray-queue-meta">
                <span className="tray-queue-title">{item.title}</span>
                <span className="tray-queue-artist">{item.artist}</span>
              </span>
            </button>
            <button
              type="button"
              className="tray-queue-remove"
              aria-label={`Remove ${item.title} from queue`}
              onClick={() => command({ type: "removeQueueItem", index, videoId: item.videoId })}
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
