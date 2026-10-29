import { memo } from "react";
import { ListMusic, Music, Play, SearchX, X } from "lucide-react";
import { ArtworkImage } from "../components/ArtworkImage";
import { CardGrid } from "../components/TrackCard";
import { playableOnly } from "../lib/trackItems";
import { SkeletonGrid } from "../components/SkeletonGrid";
import { cleanDisplayTitle } from "../lib/displayText";
import type { SearchResult } from "../lib/search";
import type { SearchFilter } from "../lib/useSearch";
import type { BrowseProps } from "./types";

interface SearchResultsViewProps extends BrowseProps {
  query: string;
  isSearching: boolean;
  /** Unfiltered result count; the badge only shows once something came back. */
  totalResults: number;
  results: SearchResult[];
  filter: SearchFilter;
  onFilterChange: (filter: SearchFilter) => void;
  onClear: () => void;
}

const FILTERS: Array<{ value: SearchFilter; label: string; icon?: typeof Music }> = [
  { value: "all", label: "All" },
  { value: "song", label: "Songs", icon: Music },
  { value: "playlist", label: "Playlists", icon: ListMusic },
];

export const SearchResultsView = memo(function SearchResultsView({
  query,
  isSearching,
  totalResults,
  results,
  filter,
  onFilterChange,
  onClear,
  ...browse
}: SearchResultsViewProps) {
  const topMatch = filter === "all" ? results[0] : undefined;
  const gridItems = filter === "all" ? results.slice(1) : results;

  return (
    <div className="search-view-container" aria-label="Search results">
      <div className="search-header-panel">
        <div className="search-header-meta">
          <span className="dot-red-accent" />
          <h2 className="search-header-title">
            {isSearching ? "Searching..." : `Results for "${query}"`}
          </h2>
          {!isSearching && totalResults > 0 && (
            <span className="search-count-badge">
              {results.length} {results.length === 1 ? "item" : "items"}
            </span>
          )}
        </div>

        <div className="search-header-actions">
          <div className="search-filter-pills">
            {FILTERS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                className={`search-filter-pill ${filter === value ? "active" : ""}`}
                onClick={() => onFilterChange(value)}
              >
                {Icon ? (
                  <>
                    <Icon size={11} />
                    <span>{label}</span>
                  </>
                ) : (
                  label
                )}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="search-clear-action-btn"
            onClick={onClear}
            title="Clear search query"
          >
            <X size={13} strokeWidth={2.2} />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {isSearching ? (
        <SkeletonGrid count={8} />
      ) : results.length === 0 ? (
        <div className="search-empty-state">
          <div className="search-empty-icon-wrap">
            <SearchX size={34} strokeWidth={1.5} />
          </div>
          <h3 className="search-empty-title">No matches found</h3>
          <p className="search-empty-desc">
            We couldn&apos;t find any results for &ldquo;{query}&rdquo;. Try checking your spelling or
            searching for another track.
          </p>
          <button type="button" className="search-empty-clear-btn" onClick={onClear}>
            Clear Search
          </button>
        </div>
      ) : (
        <div className="search-results-content">
          {topMatch && (
            <div className="search-top-spotlight">
              <span className="search-subheading-label">TOP MATCH</span>
              <div
                className="top-match-card"
                onClick={() => browse.onCardClick(topMatch)}
                onContextMenu={(e) =>
                  browse.onContextMenu(e, topMatch, "card", { contextList: playableOnly(results) })
                }
                role="button"
                tabIndex={0}
              >
                <div className="top-match-cover-wrap">
                  <ArtworkImage
                    src={topMatch.thumbnailUrl}
                    videoId={topMatch.videoId}
                    alt={topMatch.title}
                    className="top-match-cover"
                    priority
                  />
                  <button
                    type="button"
                    className="top-match-play-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      browse.onCardClick(topMatch, playableOnly(results));
                    }}
                    aria-label="Play Top Match"
                  >
                    <Play size={20} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />
                  </button>
                </div>

                <div className="top-match-meta">
                  <span className={`card-type-pill ${topMatch.itemType || "song"}`}>
                    {topMatch.itemType === "playlist" ? "Playlist" : "Song"}
                  </span>
                  <h3 className="top-match-title" title={topMatch.title}>
                    {cleanDisplayTitle(topMatch.title)}
                  </h3>
                  <p className="top-match-artist">{topMatch.artist}</p>
                </div>
              </div>
            </div>
          )}

          <div className="search-grid-section">
            {filter === "all" && results.length > 1 && (
              <span className="search-subheading-label">MORE RESULTS</span>
            )}
            <CardGrid
              items={gridItems}
              className="search-cards-grid"
              contextSource={results}
              {...browse}
            />
          </div>
        </div>
      )}
    </div>
  );
});
