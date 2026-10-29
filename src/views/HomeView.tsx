import { memo } from "react";
import { TopPicksCarousel } from "../components/TopPicksCarousel";
import { CardGrid } from "../components/TrackCard";
import { playableOnly } from "../lib/trackItems";
import { SectionHeader } from "../components/SectionHeader";
import type { HomeSection, SearchResult } from "../lib/search";
import type { BrowseProps } from "./types";

interface HomeViewProps extends BrowseProps {
  sections: HomeSection[];
  topPicksItems: SearchResult[];
  /** The shelf the carousel came from; it is left out of the list below. */
  topPicksShelfIndex: number;
  isLoadingMore: boolean;
  isPlaying: boolean;
  onPlay: (track: SearchResult) => void;
  onOpenPlaylist: (playlistId: string) => void;
}

/** Personalised home feed: Top Picks carousel, then the recommendation shelves. */
export const HomeView = memo(function HomeView({
  sections,
  topPicksItems,
  topPicksShelfIndex,
  isLoadingMore,
  isPlaying,
  onPlay,
  onOpenPlaylist,
  ...browse
}: HomeViewProps) {
  const hasTopPicks = topPicksItems.length > 0;
  return (
    <div className="home-shelves-container">
      {hasTopPicks && (
        <TopPicksCarousel
          items={topPicksItems}
          onPlay={onPlay}
          onOpenPlaylist={onOpenPlaylist}
          onContextMenu={(e, item) =>
            browse.onContextMenu(e, item, "top-picks", {
              contextList: playableOnly(topPicksItems),
            })
          }
          currentTrackId={browse.currentVideoId}
          isPlaying={isPlaying}
        />
      )}

      {sections.map((section, idx) =>
        hasTopPicks && idx === topPicksShelfIndex ? null : (
          <section key={idx} className="content-section">
            <SectionHeader title={section.title} />
            <CardGrid items={section.items} keyPrefix={`${idx}-`} {...browse} />
          </section>
        ),
      )}

      {isLoadingMore && (
        <div className="shelves-loading-indicator">
          <span className="loading-spinner" />
          <span>Loading more recommendations...</span>
        </div>
      )}
    </div>
  );
});
