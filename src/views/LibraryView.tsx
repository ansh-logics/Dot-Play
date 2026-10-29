import { memo } from "react";
import { Library, RefreshCw, UserPlus } from "lucide-react";
import { CardGrid } from "../components/TrackCard";
import { SectionHeader } from "../components/SectionHeader";
import type { HomeSection, SearchResult } from "../lib/search";
import type { BrowseProps } from "./types";

interface LibraryViewProps extends BrowseProps {
  isLoggedIn: boolean;
  isLoggingIn: boolean;
  isLoading: boolean;
  sections: HomeSection[];
  featuredPlaylists: SearchResult[];
  onRefresh: () => void;
  onSignIn: () => void;
}

/** Saved playlists from the account, then playlists featured on the home feed. */
export const LibraryView = memo(function LibraryView({
  isLoggedIn,
  isLoggingIn,
  isLoading,
  sections,
  featuredPlaylists,
  onRefresh,
  onSignIn,
  ...browse
}: LibraryViewProps) {
  return (
    <div className="library-view-container" aria-label="Playlists and library">
      <div className="history-header-panel">
        <div className="history-header-meta">
          <span className="dot-red-accent" />
          <div>
            <h2 className="history-header-title">PLAYLISTS & LIBRARY</h2>
            <p className="history-header-subtitle">
              {isLoggedIn
                ? "Your liked music, saved playlists, and collections"
                : "Personalized playlists and YouTube Music collections"}
            </p>
          </div>
        </div>

        {isLoggedIn && (
          <button
            type="button"
            className="history-refresh-btn"
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh library playlists"
          >
            <RefreshCw size={13} className={isLoading ? "history-spin" : ""} />
            <span>Refresh</span>
          </button>
        )}
      </div>

      {!isLoggedIn && (
        <div className="history-auth-prompt" style={{ margin: "16px 0 24px" }}>
          <div className="history-auth-icon-wrap">
            <Library size={28} strokeWidth={1.8} />
          </div>
          <h3 className="history-auth-title">SYNC YOUR SAVED PLAYLISTS</h3>
          <p className="history-auth-desc">
            Sign in with your Google account to access your Liked Music, custom playlists, and saved
            albums in one click.
          </p>
          <button
            type="button"
            className="history-signin-btn"
            disabled={isLoggingIn}
            onClick={onSignIn}
          >
            <UserPlus size={14} />
            <span>{isLoggingIn ? "CONNECTING..." : "Sign In with Google"}</span>
          </button>
        </div>
      )}

      {isLoggedIn && isLoading && sections.length === 0 ? (
        <div className="history-loading-view" style={{ padding: "40px 0", textAlign: "center" }}>
          <span className="loading-spinner large" />
          <p className="loading-label" style={{ marginTop: 12 }}>
            Loading your saved playlists...
          </p>
        </div>
      ) : (
        sections.map((section, idx) => (
          <section key={idx} className="content-section">
            <SectionHeader title={section.title} />
            <CardGrid
              items={section.items}
              keyPrefix={`${idx}-`}
              fallbackKind="playlist"
              withContext={false}
              {...browse}
            />
          </section>
        ))
      )}

      {featuredPlaylists.length > 0 && (
        <section className="content-section" style={{ marginTop: 20 }}>
          <SectionHeader title="Featured & Recommended Playlists" />
          <CardGrid
            items={featuredPlaylists.slice(0, 12)}
            keyPrefix="feat-"
            fallbackKind="playlist"
            withContext={false}
            {...browse}
          />
        </section>
      )}
    </div>
  );
});
