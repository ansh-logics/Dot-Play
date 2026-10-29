import { memo } from "react";
import { Clock, History, RefreshCw, Trash2 } from "lucide-react";
import { CardGrid } from "../components/TrackCard";
import { RecentSearchChips } from "../components/RecentSearchChips";
import { SectionHeader } from "../components/SectionHeader";
import { SkeletonGrid } from "../components/SkeletonGrid";
import type { HomeSection } from "../lib/search";
import type { BrowseProps } from "./types";

interface HistoryViewProps extends BrowseProps {
  isLoggedIn: boolean;
  isLoggingIn: boolean;
  isLoading: boolean;
  sections: HomeSection[];
  recentSearches: string[];
  onRefresh: () => void;
  onSignIn: () => void;
  onSelectRecent: (query: string) => void;
  onDeleteRecent: (query: string) => void;
  onClearRecent: () => void;
}

/** Listening history from YouTube Music, with recent searches on top. */
export const HistoryView = memo(function HistoryView({
  isLoggedIn,
  isLoggingIn,
  isLoading,
  sections,
  recentSearches,
  onRefresh,
  onSignIn,
  onSelectRecent,
  onDeleteRecent,
  onClearRecent,
  ...browse
}: HistoryViewProps) {
  return (
    <div className="history-view-container" aria-label="Listening history">
      <div className="history-header-panel">
        <div className="history-header-meta">
          <span className="dot-red-accent" />
          <div>
            <h2 className="history-header-title">LISTENING HISTORY</h2>
            <p className="history-header-subtitle">
              {isLoggedIn
                ? "Synchronized with your YouTube Music account"
                : "YouTube Music history across all your devices"}
            </p>
          </div>
        </div>

        {isLoggedIn && (
          <button
            type="button"
            className="history-refresh-btn"
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh history"
          >
            <RefreshCw size={13} className={isLoading ? "history-spin" : ""} />
            <span>Refresh</span>
          </button>
        )}
      </div>

      {recentSearches.length > 0 && (
        <div className="history-recent-searches-box">
          <div className="recent-searches-header">
            <div className="recent-header-left">
              <Clock size={13} className="recent-header-icon" />
              <span className="recent-header-title">RECENT SEARCHES</span>
              <span className="search-count-badge">{recentSearches.length}</span>
            </div>
            <button
              type="button"
              className="clear-recent-btn"
              onClick={onClearRecent}
              title="Clear all recent searches"
            >
              <Trash2 size={12} />
              <span>Clear All</span>
            </button>
          </div>
          <RecentSearchChips
            searches={recentSearches}
            onSelect={onSelectRecent}
            onDelete={onDeleteRecent}
          />
        </div>
      )}

      {!isLoggedIn ? (
        <div className="history-auth-prompt">
          <div className="history-auth-icon-wrap">
            <History size={36} strokeWidth={1.5} />
          </div>
          <h3 className="history-auth-title">SYNC YOUR LISTENING HISTORY</h3>
          <p className="history-auth-desc">
            Sign in with your YouTube Music account to stream and synchronize your listening history
            across all devices.
          </p>
          <button
            type="button"
            className="history-signin-btn"
            disabled={isLoggingIn}
            onClick={onSignIn}
          >
            {isLoggingIn ? "CONNECTING..." : "CONNECT WITH YOUTUBE MUSIC"}
          </button>
        </div>
      ) : isLoading ? (
        <div className="history-shelves-loading">
          <SkeletonGrid count={12} />
        </div>
      ) : sections.length === 0 ? (
        <div className="search-empty-state">
          <div className="search-empty-icon-wrap">
            <History size={34} strokeWidth={1.5} />
          </div>
          <h3 className="search-empty-title">No listening history yet</h3>
          <p className="search-empty-desc">
            Play songs on dot(.)music or YouTube Music, and your listening history will appear here.
          </p>
        </div>
      ) : (
        <div className="history-shelves-list">
          {sections.map((section, sIdx) => (
            <section key={sIdx} className="content-section">
              <SectionHeader title={section.title} count={section.items.length} />
              <CardGrid items={section.items} keyPrefix={`${sIdx}-`} {...browse} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
});
