import { memo } from "react";
import { History, RefreshCw } from "lucide-react";
import { CardGrid } from "../components/TrackCard";
import { SectionHeader } from "../components/SectionHeader";
import { SkeletonGrid } from "../components/SkeletonGrid";
import type { HomeSection } from "../lib/search";
import type { BrowseProps } from "./types";

interface HistoryViewProps extends BrowseProps {
  isLoggedIn: boolean;
  isLoggingIn: boolean;
  isLoading: boolean;
  sections: HomeSection[];
  onRefresh: () => void;
  onSignIn: () => void;
}

/** Listening history: plays in dot(.)music merged with YouTube Music's history. */
export const HistoryView = memo(function HistoryView({
  isLoggedIn,
  isLoggingIn,
  isLoading,
  sections,
  onRefresh,
  onSignIn,
  ...browse
}: HistoryViewProps) {
  return (
    <div className="history-view-container" aria-label="Listening history">
      <div className="history-header-panel">
        <div className="history-header-meta">
          <span className="dot-red-accent" />
          <div>
            <h2 className="history-header-title">Listening History</h2>
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

      {!isLoggedIn && (
        <div className="history-auth-prompt">
          <div className="history-auth-icon-wrap">
            <History size={36} strokeWidth={1.5} />
          </div>
          <h3 className="history-auth-title">Sync your listening history</h3>
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
            {isLoggingIn ? "Connecting…" : "Connect YouTube Music"}
          </button>
        </div>
      )}

      {/* The saved history stays on screen while a refresh runs. */}
      {isLoading && sections.length === 0 ? (
        <div className="history-shelves-loading">
          <SkeletonGrid count={12} />
        </div>
      ) : sections.length === 0 ? (
        isLoggedIn && (
          <div className="search-empty-state">
            <div className="search-empty-icon-wrap">
              <History size={34} strokeWidth={1.5} />
            </div>
            <h3 className="search-empty-title">No listening history yet</h3>
            <p className="search-empty-desc">
              Play songs on dot(.)music or YouTube Music, and your listening history will appear here.
            </p>
          </div>
        )
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
