import type { MusicContextTarget } from "../components/MusicContextMenu";
import type { SearchResult } from "../lib/search";

export type NavTab = "home" | "search" | "library" | "history";

export type CardClickHandler = (item: SearchResult, contextList?: SearchResult[]) => void;

export type CardContextMenuHandler = (
  e: React.MouseEvent,
  track: SearchResult,
  source: MusicContextTarget["source"],
  extra?: { upcomingIndex?: number; contextList?: SearchResult[] },
) => void;

/** What every browse view needs to highlight the playing song and react to cards. */
export interface BrowseProps {
  currentVideoId: string | undefined;
  currentPlaylistId: string | undefined;
  onCardClick: CardClickHandler;
  onContextMenu: CardContextMenuHandler;
}
