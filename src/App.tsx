import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { HiddenYouTubePlayer } from "./components/HiddenYouTubePlayer";
import { MusicContextMenu, type MusicContextTarget } from "./components/MusicContextMenu";
import { Toast } from "./components/Toast";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { SearchBar } from "./components/SearchBar";
import { SidebarNav } from "./components/sidebar/SidebarNav";
import { SidebarPlayer } from "./components/sidebar/SidebarPlayer";
import { SidebarQueue } from "./components/sidebar/SidebarQueue";
import { AccountCard } from "./components/sidebar/AccountCard";
import { SettingsModal } from "./components/modals/SettingsModal";
import { SupportModal } from "./components/modals/SupportModal";
import { NowPlaying } from "./components/now-playing/NowPlaying";
import { HomeView } from "./views/HomeView";
import { HistoryView } from "./views/HistoryView";
import { LibraryView } from "./views/LibraryView";
import { PlaylistView } from "./views/PlaylistView";
import { SearchLandingView } from "./views/SearchLandingView";
import { SearchResultsView } from "./views/SearchResultsView";
import type { CardClickHandler, CardContextMenuHandler, NavTab } from "./views/types";
import { ArrowLeft } from "lucide-react";
import { getPlaylistDetails, type PlaylistDetails, type SearchResult } from "./lib/search";
import { cacheTracks } from "./lib/trackCache";
import { loadFeedbackPrefs, saveFeedbackPrefs, type FeedbackPrefs } from "./lib/feedback";
import { useAccountData } from "./lib/useAccountData";
import { useKeyboardShortcuts } from "./lib/useKeyboardShortcuts";
import { usePlayback } from "./lib/usePlayback";
import { useSearch } from "./lib/useSearch";

/** Start loading the next home shelves this close (px) to the bottom of the page. */
const LOAD_MORE_THRESHOLD = 450;

function App() {
  const [activeNav, setActiveNav] = useState<NavTab>("home");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [showNowPlaying, setShowNowPlaying] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [contextTarget, setContextTarget] = useState<MusicContextTarget | null>(null);

  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistDetails | null>(null);
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const playlistRequestRef = useRef(0);

  const [feedbackPrefs, setFeedbackPrefs] = useState<FeedbackPrefs>(loadFeedbackPrefs);
  const updateFeedbackPrefs = useCallback((patch: Partial<FeedbackPrefs>) => {
    setFeedbackPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveFeedbackPrefs(next);
      return next;
    });
  }, []);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement>(null);

  const showToast = useCallback((msg: string) => setToastMessage(msg), []);
  const dismissToast = useCallback(() => setToastMessage(null), []);

  const search = useSearch();
  const { searchQuery, setSearchQuery, rememberSearch } = search;
  const isSearchActive = searchQuery.trim().length > 0;
  const searchQueryRef = useRef(searchQuery);
  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  const account = useAccountData({
    showToast,
    isSearchActive,
    onSignedOut: () => {
      setSelectedPlaylist(null);
      setActiveNav((current) => (current === "library" || current === "history" ? "home" : current));
      playback.clearSessionHistory();
    },
  });

  const playback = usePlayback({
    showToast,
    onPlaybackRecorded: account.addToHistory,
    playlistTracks: selectedPlaylist?.tracks,
  });
  const { currentTrack, selectTrack } = playback;
  const currentVideoId = currentTrack?.videoId;
  const currentPlaylistId = currentTrack?.playlistId;

  // Home feed: the first shelf with at least 3 items feeds the Top Picks carousel and
  // is left out of the shelf list so it isn't shown twice.
  const { homeSections, historySections } = account;
  const topPicksShelfIndex = useMemo(() => {
    if (homeSections.length === 0) return -1;
    const idx = homeSections.findIndex((s) => s.items.length >= 3);
    return idx === -1 ? 0 : idx;
  }, [homeSections]);
  const topPicksItems = useMemo(
    () => (topPicksShelfIndex >= 0 ? homeSections[topPicksShelfIndex].items.slice(0, 8) : []),
    [homeSections, topPicksShelfIndex],
  );
  const featuredPlaylists = useMemo(() => {
    const seen = new Set<string>();
    const list: SearchResult[] = [];
    for (const s of homeSections) {
      for (const item of s.items) {
        if (item.itemType === "playlist" && item.playlistId && !seen.has(item.playlistId)) {
          seen.add(item.playlistId);
          list.push(item);
        }
      }
    }
    return list;
  }, [homeSections]);

  // Playlists: only the latest request may fill the view.
  const openPlaylist = useCallback(async (playlistId: string) => {
    const requestId = ++playlistRequestRef.current;
    setIsLoadingPlaylist(true);
    setPlaylistError(null);
    setSelectedPlaylist(null);
    try {
      const details = await getPlaylistDetails(playlistId);
      if (requestId !== playlistRequestRef.current) return;
      setSelectedPlaylist(details);
      if (details.tracks && details.tracks.length > 0) {
        cacheTracks(details.tracks);
      }
    } catch (err) {
      if (requestId !== playlistRequestRef.current) return;
      setPlaylistError("Could not load playlist details.");
      console.error(err);
    } finally {
      if (requestId === playlistRequestRef.current) setIsLoadingPlaylist(false);
    }
  }, []);

  const closePlaylist = useCallback(() => setSelectedPlaylist(null), []);
  const dismissPlaylistError = useCallback(() => setPlaylistError(null), []);

  const handleCardClick = useCallback<CardClickHandler>(
    (item) => {
      rememberSearch(searchQueryRef.current);
      if (item.itemType === "playlist" && item.playlistId) {
        void openPlaylist(item.playlistId);
      } else if (item.videoId) {
        selectTrack(item);
      }
    },
    [openPlaylist, rememberSearch, selectTrack],
  );

  const handleContextMenu = useCallback<CardContextMenuHandler>((e, track, source, extra) => {
    e.preventDefault();
    e.stopPropagation();
    setContextTarget({
      track,
      source,
      upcomingIndex: extra?.upcomingIndex,
      contextList: extra?.contextList,
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  const closeContextMenu = useCallback(() => setContextTarget(null), []);

  const { handleSelectUpcoming } = playback;
  const handleContextPlayNow = useCallback(
    (track: SearchResult, contextList?: SearchResult[]) => {
      // Playing a song from the queue panel itself keeps the queue as it is.
      if (contextTarget?.source === "upcoming" || contextTarget?.source === "history") {
        handleSelectUpcoming(track);
        return;
      }
      selectTrack(track, contextTarget?.source === "playlist" ? contextList : undefined);
    },
    [contextTarget?.source, handleSelectUpcoming, selectTrack],
  );

  // Navigation
  const { isLoggedIn, fetchHistory, fetchLibrary, librarySections } = account;
  const focusSearch = useCallback(() => {
    searchInputRef.current?.focus();
    setActiveNav("search");
  }, []);

  const handleNavigate = useCallback(
    (tab: NavTab) => {
      setActiveNav(tab);
      if (tab === "search") {
        searchInputRef.current?.focus();
        return;
      }
      setSearchQuery("");
      setSelectedPlaylist(null);
      if (tab === "library" && isLoggedIn && librarySections.length === 0) void fetchLibrary();
      if (tab === "history" && isLoggedIn && historySections.length === 0) void fetchHistory();
    },
    [setSearchQuery, isLoggedIn, librarySections.length, historySections.length, fetchLibrary, fetchHistory],
  );

  // Opening History or Playlists with nothing loaded yet fetches it.
  useEffect(() => {
    if (activeNav === "history" && isLoggedIn && historySections.length === 0) {
      void fetchHistory();
    }
  }, [activeNav, isLoggedIn, historySections.length, fetchHistory]);

  useEffect(() => {
    if (activeNav === "library" && isLoggedIn && librarySections.length === 0) {
      void fetchLibrary();
    }
  }, [activeNav, isLoggedIn, librarySections.length, fetchLibrary]);

  const handleQueryChange = useCallback(
    (query: string) => {
      setSearchQuery(query);
      setActiveNav("search");
    },
    [setSearchQuery],
  );
  const clearSearch = useCallback(() => setSearchQuery(""), [setSearchQuery]);
  const hasOpenPlaylist = selectedPlaylist !== null;
  const handleSearchFocus = useCallback(() => {
    if (!hasOpenPlaylist) setActiveNav("search");
  }, [hasOpenPlaylist]);

  const { selectRecentSearch } = search;
  const handleSelectRecent = useCallback(
    (query: string) => {
      selectRecentSearch(query);
      setActiveNav("search");
    },
    [selectRecentSearch],
  );

  // Account
  const { initiateLogin, signOut, refreshAuthSession } = account;
  const handleSignIn = useCallback(
    (switchAccount: boolean) => void initiateLogin(switchAccount),
    [initiateLogin],
  );
  const handleSignInFresh = useCallback(() => void initiateLogin(false), [initiateLogin]);
  const handleSignOut = useCallback(() => {
    setShowProfileMenu(false);
    void signOut();
  }, [signOut]);
  const handleRetrySync = useCallback(() => void refreshAuthSession(), [refreshAuthSession]);

  const openSupport = useCallback(() => setShowSupportModal(true), []);
  const openSettings = useCallback(() => setShowSettingsModal(true), []);
  const toggleQueue = useCallback(() => setShowQueue((open) => !open), []);
  const openNowPlaying = useCallback(() => setShowNowPlaying(true), []);
  const closeNowPlaying = useCallback(() => setShowNowPlaying(false), []);

  // Infinite scroll on the home feed, checked at most every 150 ms.
  const { loadMoreShelves } = account;
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    let debounceTimer: number | undefined;
    const handleScroll = () => {
      if (debounceTimer) return;
      debounceTimer = window.setTimeout(() => {
        debounceTimer = undefined;
        const { scrollTop, scrollHeight, clientHeight } = container;
        if (scrollHeight - (scrollTop + clientHeight) < LOAD_MORE_THRESHOLD) {
          void loadMoreShelves();
        }
      }, 150);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (debounceTimer) window.clearTimeout(debounceTimer);
    };
  }, [loadMoreShelves]);

  useKeyboardShortcuts({
    onEscape: () => {
      if (showSettingsModal) setShowSettingsModal(false);
      else if (showSupportModal) setShowSupportModal(false);
      else if (showProfileMenu) setShowProfileMenu(false);
      else if (showQueue) setShowQueue(false);
      else if (selectedPlaylist) setSelectedPlaylist(null);
      else if (document.activeElement === searchInputRef.current) searchInputRef.current?.blur();
      else return false;
      return true;
    },
    onTogglePlayPause: playback.togglePlayPause,
    onSeekRelative: playback.seekRelative,
    onToggleNowPlaying: () => {
      if (!currentTrack) return false;
      setShowNowPlaying((open) => !open);
      return true;
    },
    onFocusSearch: focusSearch,
  });

  const browse = {
    currentVideoId,
    currentPlaylistId,
    onCardClick: handleCardClick,
    onContextMenu: handleContextMenu,
  };

  const renderMainView = () => {
    if (isLoadingPlaylist) {
      return (
        <div className="playlist-loading-view">
          <span className="loading-spinner large" />
          <p className="loading-label">Loading playlist tracks...</p>
        </div>
      );
    }
    if (selectedPlaylist) {
      return (
        <PlaylistView
          playlist={selectedPlaylist}
          currentVideoId={currentVideoId}
          onBack={closePlaylist}
          onSelectTrack={selectTrack}
          onAppendToQueue={playback.handleAppendTracksToQueue}
          onPlayNext={playback.handlePlayNext}
          onAddToQueue={playback.handleAddToQueue}
          onContextMenu={handleContextMenu}
        />
      );
    }
    if (playlistError) {
      return (
        <div className="playlist-error-view">
          <p className="empty-message">{playlistError}</p>
          <button type="button" className="back-nav-btn" onClick={dismissPlaylistError}>
            <ArrowLeft size={16} strokeWidth={2} />
            <span>Back to Home</span>
          </button>
        </div>
      );
    }
    if (isSearchActive) {
      return (
        <SearchResultsView
          query={searchQuery}
          isSearching={search.isSearching}
          totalResults={search.searchResults.length}
          results={search.filteredSearchResults}
          filter={search.searchFilter}
          onFilterChange={search.setSearchFilter}
          onClear={clearSearch}
          {...browse}
        />
      );
    }
    if (activeNav === "history") {
      return (
        <HistoryView
          isLoggedIn={isLoggedIn}
          isLoggingIn={account.isLoggingIn}
          isLoading={account.isLoadingHistory}
          sections={historySections}
          recentSearches={search.recentSearches}
          onRefresh={fetchHistory}
          onSignIn={handleSignInFresh}
          onSelectRecent={handleSelectRecent}
          onDeleteRecent={search.deleteRecentSearch}
          onClearRecent={search.clearAllRecentSearches}
          {...browse}
        />
      );
    }
    if (activeNav === "library") {
      return (
        <LibraryView
          isLoggedIn={isLoggedIn}
          isLoggingIn={account.isLoggingIn}
          isLoading={account.isLoadingLibrary}
          sections={librarySections}
          featuredPlaylists={featuredPlaylists}
          onRefresh={fetchLibrary}
          onSignIn={handleSignInFresh}
          {...browse}
        />
      );
    }
    if (activeNav === "search") {
      return (
        <SearchLandingView
          recentSearches={search.recentSearches}
          recentlyPlayed={isLoggedIn && historySections.length > 0 ? historySections[0].items : null}
          onSelectRecent={handleSelectRecent}
          onDeleteRecent={search.deleteRecentSearch}
          onClearRecent={search.clearAllRecentSearches}
          {...browse}
        />
      );
    }
    return (
      <HomeView
        sections={homeSections}
        topPicksItems={topPicksItems}
        topPicksShelfIndex={topPicksShelfIndex}
        isLoadingMore={account.isLoadingMore}
        isPlaying={playback.playerState === "playing"}
        onPlay={selectTrack}
        onOpenPlaylist={openPlaylist}
        {...browse}
      />
    );
  };

  return (
    <div className="music-app-layout">
      <div className="app-body-container">
        <aside className="app-sidebar">
          <div className="sidebar-brand">
            <div className="brand-dot-logo">
              <span className="brand-red-dot" />
            </div>
            <div className="brand-title-wrap">
              <span className="brand-title">dot(.)music</span>
            </div>
          </div>

          <SidebarNav
            activeNav={activeNav}
            hasSearchQuery={searchQuery.length > 0}
            hasOpenPlaylist={hasOpenPlaylist}
            isSupportOpen={showSupportModal}
            isSettingsOpen={showSettingsModal}
            onNavigate={handleNavigate}
            onOpenSupport={openSupport}
            onOpenSettings={openSettings}
          />

          {currentTrack && (
            <SidebarPlayer
              track={currentTrack}
              isQueueOpen={showQueue}
              isPlayerReady={playback.isPlayerReady}
              playerState={playback.playerState}
              currentTime={playback.currentTime}
              duration={playback.duration}
              playbackError={playback.playbackError}
              isMuted={playback.isMuted}
              onToggleQueue={toggleQueue}
              onOpenNowPlaying={openNowPlaying}
              onBeginScrub={playback.beginScrub}
              onScrub={playback.scrubTo}
              onEndScrub={playback.endScrub}
              onToggleMute={playback.toggleMute}
              onPrevious={playback.handlePreviousTrack}
              onPlayPause={playback.togglePlayPause}
              onNext={playback.handleNextTrack}
            >
              <SidebarQueue
                isOpen={showQueue}
                upcoming={playback.session.upcoming}
                history={playback.session.history}
                onReorder={playback.handleUpcomingReorder}
                onSelect={handleSelectUpcoming}
                onRemove={playback.handleRemoveUpcoming}
                onClear={playback.handleClearUpcoming}
                onPlayNext={playback.handlePlayNext}
                onAddToQueue={playback.handleAddToQueue}
                onContextMenu={handleContextMenu}
              />
            </SidebarPlayer>
          )}

          <AccountCard
            profile={account.userProfile}
            isLoggedIn={isLoggedIn}
            isLoggingIn={account.isLoggingIn}
            authSyncError={account.authSyncError}
            isMenuOpen={showProfileMenu}
            onMenuOpenChange={setShowProfileMenu}
            onRetrySync={handleRetrySync}
            onSignIn={handleSignIn}
            onSignOut={handleSignOut}
          />
        </aside>

        <div className="app-main-area">
          <SearchBar
            ref={searchInputRef}
            query={searchQuery}
            onQueryChange={handleQueryChange}
            onClear={clearSearch}
            onFocus={handleSearchFocus}
            onSubmit={rememberSearch}
          />
          <main ref={contentRef} className="app-main-content">
            {renderMainView()}
          </main>
        </div>
      </div>

      {/* Hidden audio engine */}
      <HiddenYouTubePlayer
        key="global-audio-engine"
        videoId={currentVideoId}
        initialSeconds={playback.initialPlaybackSeconds}
        autoPlayOnMount={playback.autoPlayOnMount}
        onReady={playback.handlePlayerReady}
        onStateChange={playback.handlePlayerStateChange}
        onError={playback.handlePlayerError}
        onTrackChange={playback.handleTrackChangeFromIframe}
      />

      {showSettingsModal && (
        <SettingsModal
          feedbackPrefs={feedbackPrefs}
          onFeedbackChange={updateFeedbackPrefs}
          isLoggedIn={isLoggedIn}
          accountEmail={account.userProfile?.email}
          onSignOut={handleSignOut}
          onClose={() => setShowSettingsModal(false)}
        />
      )}

      {showSupportModal && <SupportModal onClose={() => setShowSupportModal(false)} />}

      <NowPlaying
        isOpen={showNowPlaying}
        onClose={closeNowPlaying}
        session={playback.session}
        isPlaying={playback.playerState === "playing"}
        isBuffering={playback.playerState === "buffering"}
        isReady={playback.isPlayerReady}
        currentTime={playback.currentTime}
        duration={playback.duration}
        playbackError={playback.playbackError}
        volume={playback.volume}
        isMuted={playback.isMuted}
        modes={playback.playbackModes}
        onPlayPause={playback.togglePlayPause}
        onNext={playback.handleNextTrack}
        onPrevious={playback.handlePreviousTrack}
        onSeek={playback.seekTo}
        onToggleMute={playback.toggleMute}
        onVolumeChange={playback.changeVolume}
        onCycleRepeat={playback.cycleRepeatMode}
        onToggleAutoplay={playback.toggleAutoplay}
        onToggleShuffle={playback.toggleShuffle}
        onSelectTrack={handleSelectUpcoming}
        onReorderUpcoming={playback.handleUpcomingReorder}
        onRemoveUpcoming={playback.handleRemoveUpcoming}
        onClearUpcoming={playback.handleClearUpcoming}
        onPlayNext={playback.handlePlayNext}
        onAddToQueue={playback.handleAddToQueue}
        onContextMenu={handleContextMenu}
      />

      <MusicContextMenu
        target={contextTarget}
        onClose={closeContextMenu}
        onPlayNow={handleContextPlayNow}
        onPlayNext={playback.handlePlayNext}
        onAddToQueue={playback.handleAddToQueue}
        onRemoveFromQueue={playback.handleRemoveUpcoming}
        onOpenPlaylist={openPlaylist}
      />

      <Toast message={toastMessage} onDismiss={dismissToast} />

      <UpdatePrompt />
    </div>
  );
}

export default App;
