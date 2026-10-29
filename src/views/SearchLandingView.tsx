import { memo } from "react";
import { Clock, Trash2 } from "lucide-react";
import { CardGrid } from "../components/TrackCard";
import { RecentSearchChips } from "../components/RecentSearchChips";
import { SectionHeader } from "../components/SectionHeader";
import type { SearchResult } from "../lib/search";
import type { BrowseProps } from "./types";

interface SearchLandingViewProps extends BrowseProps {
  recentSearches: string[];
  /** Latest history shelf; shown when signed in. */
  recentlyPlayed: SearchResult[] | null;
  onSelectRecent: (query: string) => void;
  onDeleteRecent: (query: string) => void;
  onClearRecent: () => void;
}

/** The Search tab before anything is typed: recent searches and recently played. */
export const SearchLandingView = memo(function SearchLandingView({
  recentSearches,
  recentlyPlayed,
  onSelectRecent,
  onDeleteRecent,
  onClearRecent,
  ...browse
}: SearchLandingViewProps) {
  return (
    <div className="search-landing-container" aria-label="Search landing">
      <div className="search-landing-card">
        <div className="recent-searches-header">
          <div className="recent-header-left">
            <span className="dot-red-accent small" />
            <h2 className="search-subheading-label">RECENT SEARCHES</h2>
            {recentSearches.length > 0 && (
              <span className="search-count-badge">{recentSearches.length}</span>
            )}
          </div>
          {recentSearches.length > 0 && (
            <button
              type="button"
              className="clear-recent-btn"
              onClick={onClearRecent}
              title="Clear all recent searches"
            >
              <Trash2 size={12} />
              <span>Clear All</span>
            </button>
          )}
        </div>

        {recentSearches.length > 0 ? (
          <RecentSearchChips
            searches={recentSearches}
            onSelect={onSelectRecent}
            onDelete={onDeleteRecent}
          />
        ) : (
          <div className="recent-empty-hint">
            <Clock size={16} strokeWidth={1.5} />
            <span>No recent searches yet. Search for songs, artists, or playlists above.</span>
          </div>
        )}
      </div>

      {recentlyPlayed && (
        <section className="content-section" style={{ marginTop: 28 }}>
          <SectionHeader title="Recently Played on YouTube Music" />
          <CardGrid
            items={recentlyPlayed.slice(0, 6)}
            contextSource={recentlyPlayed}
            {...browse}
          />
        </section>
      )}
    </div>
  );
});
