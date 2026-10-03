import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  HiddenYouTubePlayer,
  type YouTubePlayerInstance,
  type YouTubePlaybackState,
} from "./components/HiddenYouTubePlayer";
import { TopPicksCarousel } from "./components/TopPicksCarousel";
import { ArtworkImage } from "./components/ArtworkImage";
import { listen } from "@tauri-apps/api/event";
import {
  Home,
  Search,
  Library,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ArrowLeft,
  X,
  Loader2,
  LogOut,
  ChevronUp,
  SearchX,
  Music,
  ListMusic,
  History,
  Clock,
  Trash2,
  RefreshCw,
  UserPlus,
} from "lucide-react";
import {
  searchTracks,
  openLoginWindow,
  getAuthStatus,
  logoutUser,
  getHomeFeed,
  getHomeFeedContinuation,
  getPlaylistDetails,
  getUserProfile,
  getHistory,
  getRecentSearches,
  saveRecentSearch,
  removeRecentSearch,
  clearRecentSearches,
  isTauriEnvironment,
  type SearchResult,
  type HomeSection,
  type PlaylistDetails,
  type UserProfile,
} from "./lib/search";
import { cacheTracks, cacheTrack } from "./lib/trackCache";

function App() {
  const [activeNav, setActiveNav] = useState<"home" | "search" | "library" | "history">("home");
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFilter, setSearchFilter] = useState<"all" | "song" | "playlist">("all");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [historySections, setHistorySections] = useState<HomeSection[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const filteredSearchResults = useMemo(() => {
    if (searchFilter === "all") return searchResults;
    return searchResults.filter((item) => (item.itemType || "song") === searchFilter);
  }, [searchResults, searchFilter]);

  const [homeSections, setHomeSections] = useState<HomeSection[]>([]);
  const [continuationToken, setContinuationToken] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  // Top picks carousel items computed from first shelf
  const topPicksItems = useMemo(() => {
    if (homeSections.length === 0) return [];
    const firstGoodShelf = homeSections.find((s) => s.items.length >= 3);
    return (firstGoodShelf ? firstGoodShelf.items : homeSections[0].items).slice(0, 8);
  }, [homeSections]);

  // Playlist view state
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistDetails | null>(null);
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);

  // Active track & playback state
  const [currentTrack, setCurrentTrack] = useState<SearchResult | null>(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [playerState, setPlayerState] =
    useState<YouTubePlaybackState>("unstarted");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const isScrubbingRef = useRef(false);
  const shouldAutoPlayRef = useRef(false);
  const contentRef = useRef<HTMLElement>(null);
  const isLoadingMoreRef = useRef(false);
  const handleNextTrackRef = useRef<() => void>(() => {});
  const profileMenuRef = useRef<HTMLDivElement>(null);

  // Dismiss profile popup on outside click or Escape
  useEffect(() => {
    if (!showProfileMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        profileMenuRef.current &&
        !profileMenuRef.current.contains(e.target as Node)
      ) {
        setShowProfileMenu(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowProfileMenu(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showProfileMenu]);

  // 1. App Startup & Auth event listeners
  useEffect(() => {
    let unlistenSuccess: (() => void) | undefined;
    let unlistenCancel: (() => void) | undefined;

    getAuthStatus().then((status) => {
      setIsLoggedIn(status);
      if (status) {
        getUserProfile().then((profile) => setUserProfile(profile));
      }
    });

    getHomeFeed().then((res) => {
      setHomeSections(res.sections);
      setContinuationToken(res.continuationToken ?? null);
      cacheTracks(res.sections.flatMap((s) => s.items));
    });

    if (isTauriEnvironment()) {
      listen("login_success", () => {
        setIsLoggedIn(true);
        setIsLoggingIn(false);
        getUserProfile().then((profile) => setUserProfile(profile));
        getHomeFeed().then((res) => {
          setHomeSections(res.sections);
          setContinuationToken(res.continuationToken ?? null);
          cacheTracks(res.sections.flatMap((s) => s.items));
        });
        getHistory().then((res) => {
          setHistorySections(res.sections);
          cacheTracks(res.sections.flatMap((s) => s.items));
        });
      }).then((un) => {
        unlistenSuccess = un;
      });

      listen("login_cancelled", () => {
        setIsLoggingIn(false);
      }).then((un) => {
        unlistenCancel = un;
      });
    }

    setRecentSearches(getRecentSearches());

    return () => {
      unlistenSuccess?.();
      unlistenCancel?.();
    };
  }, []);

  const fetchHistory = useCallback(async () => {
    if (!isLoggedIn) return;
    setIsLoadingHistory(true);
    try {
      const res = await getHistory();
      setHistorySections(res.sections);
      cacheTracks(res.sections.flatMap((s) => s.items));
    } catch (e) {
      console.error("Failed to fetch history:", e);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [isLoggedIn]);

  // Fetch history when navigating to History or when logged in
  useEffect(() => {
    if (activeNav === "history" && isLoggedIn && historySections.length === 0) {
      fetchHistory();
    }
  }, [activeNav, isLoggedIn, historySections.length, fetchHistory]);

  const handleSelectRecentSearch = (query: string) => {
    setSearchQuery(query);
    setActiveNav("search");
    const updated = saveRecentSearch(query);
    setRecentSearches(updated);
  };

  const handleDeleteRecentSearch = (e: React.MouseEvent, query: string) => {
    e.stopPropagation();
    const updated = removeRecentSearch(query);
    setRecentSearches(updated);
  };

  const handleClearAllRecentSearches = () => {
    clearRecentSearches();
    setRecentSearches([]);
  };

  // 2. Live Debounced Search
  useEffect(() => {
    const cleanQuery = searchQuery.trim();
    if (!cleanQuery) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const results = await searchTracks(cleanQuery);
        setSearchResults(results);
        cacheTracks(results);
        if (results.length > 0) {
          const updated = saveRecentSearch(cleanQuery);
          setRecentSearches(updated);
        }
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // 3. Infinite Scroll / Dynamic Feed Loading
  const loadMoreShelves = useCallback(async () => {
    if (
      !continuationToken ||
      isLoadingMoreRef.current ||
      searchQuery.trim().length > 0
    ) {
      return;
    }

    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);

    try {
      const res = await getHomeFeedContinuation(continuationToken);
      if (res.sections.length > 0) {
        cacheTracks(res.sections.flatMap((s) => s.items));
        setHomeSections((prev) => {
          const existingTitles = new Set(prev.map((s) => s.title));
          const newUnique = res.sections.filter(
            (s) => !existingTitles.has(s.title),
          );
          return [
            ...prev,
            ...(newUnique.length > 0 ? newUnique : res.sections),
          ];
        });
      }
      setContinuationToken(res.continuationToken ?? null);
    } catch (err) {
      console.error("Failed to load more shelves:", err);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [continuationToken, searchQuery]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    let debounceTimer: number | undefined;

    const handleScroll = () => {
      if (debounceTimer) return;
      debounceTimer = window.setTimeout(() => {
        debounceTimer = undefined;
        const { scrollTop, scrollHeight, clientHeight } = container;
        if (scrollHeight - (scrollTop + clientHeight) < 450) {
          loadMoreShelves();
        }
      }, 150);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (debounceTimer) window.clearTimeout(debounceTimer);
    };
  }, [loadMoreShelves]);

  // 4. Iframe Player Callbacks
  const handlePlayerReady = useCallback((player: YouTubePlayerInstance) => {
    playerRef.current = player;
    setIsPlayerReady(true);
    const initialDuration = player.getDuration();
    if (initialDuration > 0) {
      setDuration(initialDuration);
    }
    if (shouldAutoPlayRef.current) {
      player.playVideo();
      shouldAutoPlayRef.current = false;
    }
  }, []);

  const handlePlayerStateChange = useCallback((state: YouTubePlaybackState) => {
    setPlayerState(state);
    if (state === "playing") {
      setPlaybackError(null);
    } else if (state === "ended") {
      handleNextTrackRef.current();
    }
  }, []);

  const handlePlayerError = useCallback((code: number) => {
    setPlayerState("paused");
    const messages: Record<number, string> = {
      [-1]: "Could not load YouTube Player API.",
      2: "Invalid video track ID.",
      5: "YouTube HTML5 player error.",
      100: "Track is unavailable or private.",
      101: "Embedded playback blocked by track owner.",
      150: "Embedded playback blocked by track owner.",
      153: "Embedded player origin error.",
    };
    setPlaybackError(
      messages[code] ?? `Playback failed with error code ${code}.`,
    );
  }, []);

  // 4. Progress Sync Loop (250ms interval)
  useEffect(() => {
    if (!isPlayerReady || !currentTrack) return;

    const syncPlayerTime = () => {
      const player = playerRef.current;
      if (!player) return;

      if (!isScrubbingRef.current) {
        setCurrentTime(player.getCurrentTime());
      }
      const currentDuration = player.getDuration();
      if (currentDuration > 0) {
        setDuration(currentDuration);
      }
    };

    syncPlayerTime();
    const timer = window.setInterval(syncPlayerTime, 250);
    return () => window.clearInterval(timer);
  }, [isPlayerReady, currentTrack]);

  // 5. Track Selection
  const selectTrack = (track: SearchResult) => {
    const isSamePlaylist = Boolean(
      track.playlistId &&
        currentTrack?.playlistId &&
        track.playlistId === currentTrack.playlistId,
    );

    setCurrentTrack(track);
    cacheTrack(track);
    setCurrentTime(0);
    setPlaybackError(null);

    if (!isSamePlaylist) {
      shouldAutoPlayRef.current = true;
      playerRef.current = null;
      setIsPlayerReady(false);
      setPlayerState("unstarted");
      setDuration(0);
    } else {
      setPlayerState("buffering");
    }
  };

  // 6. Playlist Selection & Navigation
  const openPlaylist = async (playlistId: string) => {
    setIsLoadingPlaylist(true);
    setPlaylistError(null);
    setSelectedPlaylist(null);
    try {
      const details = await getPlaylistDetails(playlistId);
      setSelectedPlaylist(details);
      if (details.tracks && details.tracks.length > 0) {
        cacheTracks(details.tracks);
      }
    } catch (err) {
      setPlaylistError("Could not load playlist details.");
      console.error(err);
    } finally {
      setIsLoadingPlaylist(false);
    }
  };

  const handleCardClick = (item: SearchResult) => {
    if (searchQuery.trim()) {
      const updated = saveRecentSearch(searchQuery.trim());
      setRecentSearches(updated);
    }
    if (item.itemType === "playlist" && item.playlistId) {
      openPlaylist(item.playlistId);
    } else {
      selectTrack(item);
    }
  };

  // 7. Iframe Track Synchronization & Navigation Controls
  const handleTrackChangeFromIframe = useCallback(
    (info: { videoId: string; title?: string; artist?: string }) => {
      if (!info.videoId) return;

      setCurrentTrack((prev) => {
        if (!prev) return null;
        if (prev.videoId === info.videoId) return prev;

        // Check if track matches one from selectedPlaylist
        const matched = selectedPlaylist?.tracks.find(
          (t) => t.videoId === info.videoId,
        );

        if (matched) {
          return {
            videoId: matched.videoId,
            title: matched.title,
            artist: matched.artist,
            thumbnailUrl: matched.thumbnailUrl,
            playlistId: prev.playlistId || selectedPlaylist?.id,
            itemType: "song",
          };
        }

        return {
          videoId: info.videoId,
          title: info.title || prev.title,
          artist: info.artist || prev.artist,
          thumbnailUrl: `https://i.ytimg.com/vi/${info.videoId}/hqdefault.jpg`,
          playlistId: prev.playlistId,
          itemType: "song",
        };
      });
    },
    [selectedPlaylist],
  );

  const handleNextTrack = useCallback(() => {
    if (!playerRef.current) return;
    playerRef.current.nextVideo();

    if (currentTrack) {
      if (selectedPlaylist) {
        const idx = selectedPlaylist.tracks.findIndex(
          (t) => t.videoId === currentTrack.videoId,
        );
        if (idx !== -1 && idx < selectedPlaylist.tracks.length - 1) {
          const next = selectedPlaylist.tracks[idx + 1];
          setCurrentTrack({
            videoId: next.videoId,
            title: next.title,
            artist: next.artist,
            thumbnailUrl: next.thumbnailUrl,
            playlistId: selectedPlaylist.id,
            itemType: "song",
          });
          return;
        }
      } else {
        // Fallback: check home feed sections
        for (const section of homeSections) {
          const idx = section.items.findIndex(
            (t) => t.videoId === currentTrack.videoId,
          );
          if (idx !== -1 && idx < section.items.length - 1) {
            const next = section.items[idx + 1];
            if (next.videoId) {
              setCurrentTrack(next);
              return;
            }
          }
        }
        // Fallback: check search results
        if (searchResults.length > 0) {
          const idx = searchResults.findIndex(
            (t) => t.videoId === currentTrack.videoId,
          );
          if (idx !== -1 && idx < searchResults.length - 1) {
            const next = searchResults[idx + 1];
            if (next.videoId) {
              setCurrentTrack(next);
              return;
            }
          }
        }
      }
    }
  }, [selectedPlaylist, currentTrack, homeSections, searchResults]);

  useEffect(() => {
    handleNextTrackRef.current = handleNextTrack;
  }, [handleNextTrack]);

  const handlePreviousTrack = useCallback(() => {
    if (!playerRef.current) return;

    if (currentTime > 3) {
      playerRef.current.seekTo(0, true);
      setCurrentTime(0);
      return;
    }

    playerRef.current.previousVideo();

    if (currentTrack) {
      if (selectedPlaylist) {
        const idx = selectedPlaylist.tracks.findIndex(
          (t) => t.videoId === currentTrack.videoId,
        );
        if (idx > 0) {
          const prevTrack = selectedPlaylist.tracks[idx - 1];
          setCurrentTrack({
            videoId: prevTrack.videoId,
            title: prevTrack.title,
            artist: prevTrack.artist,
            thumbnailUrl: prevTrack.thumbnailUrl,
            playlistId: selectedPlaylist.id,
            itemType: "song",
          });
          return;
        }
      } else {
        for (const section of homeSections) {
          const idx = section.items.findIndex(
            (t) => t.videoId === currentTrack.videoId,
          );
          if (idx > 0) {
            const prev = section.items[idx - 1];
            if (prev.videoId) {
              setCurrentTrack(prev);
              return;
            }
          }
        }
        if (searchResults.length > 0) {
          const idx = searchResults.findIndex(
            (t) => t.videoId === currentTrack.videoId,
          );
          if (idx > 0) {
            const prev = searchResults[idx - 1];
            if (prev.videoId) {
              setCurrentTrack(prev);
              return;
            }
          }
        }
      }
    }
  }, [currentTime, selectedPlaylist, currentTrack, homeSections, searchResults]);

  const getPlayButtonLabel = () => {
    if (!isPlayerReady) return "Loading...";
    if (playerState === "buffering") return "Buffering...";
    if (playerState === "playing") return "Pause";
    if (playerState === "ended") return "Replay";
    return "Play";
  };

  return (
    <div className="music-app-layout">
      {/* App Body Container: Left Sidebar + Right Main Area */}
      <div className="app-body-container">
        {/* Left Sidebar (Nothing OS Navigation) */}
        <aside className="app-sidebar">
          {/* Brand Header */}
          <div className="sidebar-brand">
            <div className="brand-dot-logo">
              <span className="brand-red-dot" />
            </div>
            <div className="brand-title-wrap">
              <span className="brand-title">dot(.)music</span>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="sidebar-nav">
            <span className="nav-group-label">DISCOVER</span>
            <button
              type="button"
              className={`sidebar-nav-item ${activeNav === "home" && !searchQuery ? "active" : ""}`}
              onClick={() => {
                setActiveNav("home");
                setSearchQuery("");
                setSelectedPlaylist(null);
              }}
            >
              <span className="nav-item-indicator" />
              <Home size={17} strokeWidth={2} className="nav-svg-icon" />
              <span className="nav-item-label">Home</span>
            </button>

            <button
              type="button"
              className={`sidebar-nav-item ${activeNav === "search" || searchQuery ? "active" : ""}`}
              onClick={() => {
                setActiveNav("search");
                const input = document.querySelector<HTMLInputElement>(".top-search-input");
                input?.focus();
              }}
            >
              <span className="nav-item-indicator" />
              <Search size={17} strokeWidth={2} className="nav-svg-icon" />
              <span className="nav-item-label">Search</span>
            </button>

            <span className="nav-group-label">COLLECTIONS</span>
            <button
              type="button"
              className={`sidebar-nav-item ${activeNav === "library" || selectedPlaylist ? "active" : ""}`}
              onClick={() => {
                setActiveNav("library");
                const firstPlaylist = homeSections
                  .flatMap((s) => s.items)
                  .find((i) => i.itemType === "playlist" && i.playlistId);
                if (firstPlaylist?.playlistId) {
                  openPlaylist(firstPlaylist.playlistId);
                }
              }}
            >
              <span className="nav-item-indicator" />
              <Library size={17} strokeWidth={2} className="nav-svg-icon" />
              <span className="nav-item-label">Playlists</span>
            </button>

            <button
              type="button"
              className={`sidebar-nav-item ${activeNav === "history" && !selectedPlaylist ? "active" : ""}`}
              onClick={() => {
                setActiveNav("history");
                setSearchQuery("");
                setSelectedPlaylist(null);
                if (isLoggedIn && historySections.length === 0) {
                  fetchHistory();
                }
              }}
            >
              <span className="nav-item-indicator" />
              <History size={17} strokeWidth={2} className="nav-svg-icon" />
              <span className="nav-item-label">History</span>
            </button>
          </nav>

          {/* User Auth Section in Sidebar */}
          <div className="sidebar-auth-section" ref={profileMenuRef}>
            {/* Apple-style Frosted Floating Profile Popover */}
            {isLoggedIn && showProfileMenu && (
              <div className="apple-profile-popover" role="dialog" aria-label="Account details">
                <div className="popover-user-row">
                  {userProfile?.avatarUrl && (
                    <img
                      src={userProfile.avatarUrl}
                      alt={userProfile.name}
                      className="popover-avatar"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <div className="popover-user-text">
                    <span className="popover-user-name">{userProfile?.name || "Connected Account"}</span>
                    {userProfile?.email && (
                      <span className="popover-user-email">{userProfile.email}</span>
                    )}
                  </div>
                </div>

                <div className="popover-badge-row">
                  <span className="popover-status-badge">
                    <span className="nothing-status-dot online" />
                    <span>YouTube Music</span>
                  </span>
                </div>

                <div className="popover-divider" />

                <div className="popover-actions">
                  <button
                    type="button"
                    className="popover-switch-btn"
                    onClick={async () => {
                      setShowProfileMenu(false);
                      setIsLoggingIn(true);
                      await openLoginWindow(true);
                    }}
                  >
                    <UserPlus size={14} strokeWidth={2} />
                    <span>Switch Account</span>
                  </button>

                  <button
                    type="button"
                    className="popover-signout-btn"
                    onClick={async () => {
                      setShowProfileMenu(false);
                      await logoutUser();
                      setIsLoggedIn(false);
                      setUserProfile(null);
                      getHomeFeed().then((res) => {
                        setHomeSections(res.sections);
                        setContinuationToken(res.continuationToken ?? null);
                      });
                    }}
                  >
                    <LogOut size={14} strokeWidth={2} />
                    <span>Sign Out</span>
                  </button>
                </div>
              </div>
            )}

            {isLoggedIn ? (
              <button
                type="button"
                className={`sidebar-auth-card connected interactive ${showProfileMenu ? "menu-open" : ""}`}
                onClick={() => setShowProfileMenu((prev) => !prev)}
                aria-haspopup="dialog"
                aria-expanded={showProfileMenu}
              >
                <div className="auth-status-row">
                  <span className="nothing-status-dot online" />
                  <span className="auth-status-text">CONNECTED</span>
                  <ChevronUp
                    size={14}
                    className={`auth-chevron-icon ${showProfileMenu ? "rotated" : ""}`}
                  />
                </div>
                {userProfile ? (
                  <div className="auth-profile-info">
                    {userProfile.avatarUrl && (
                      <img
                        src={userProfile.avatarUrl}
                        alt={userProfile.name}
                        className="auth-profile-avatar"
                        referrerPolicy="no-referrer"
                      />
                    )}
                    <div className="auth-profile-text">
                      <span className="auth-profile-name">{userProfile.name}</span>
                      {userProfile.email && (
                        <span className="auth-profile-email">{userProfile.email}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="auth-account-desc">YouTube Music</p>
                )}
              </button>
            ) : (
              <div className="sidebar-auth-card">
                <div className="auth-status-row">
                  <span className="nothing-status-dot offline" />
                  <span className="auth-status-text">OFFLINE</span>
                </div>
                <p className="auth-account-desc">Personalize your feed</p>
                <button
                  type="button"
                  className="nothing-auth-btn signin"
                  disabled={isLoggingIn}
                  onClick={async () => {
                    setIsLoggingIn(true);
                    await openLoginWindow();
                  }}
                >
                  {isLoggingIn ? "CONNECTING..." : "SIGN IN"}
                </button>
              </div>
            )}
          </div>
        </aside>

        {/* Right Main Content Area */}
        <div className="app-main-area">
          {/* Top Bar with Search */}
          <header className="app-top-bar">
            <div className="top-search-wrap">
              <Search size={16} strokeWidth={2.2} className="top-search-svg" />
              <input
                type="text"
                className="top-search-input"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (activeNav !== "search") {
                    setActiveNav("search");
                  }
                }}
                onFocus={() => {
                  if (activeNav !== "search" && !selectedPlaylist) {
                    setActiveNav("search");
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchQuery.trim()) {
                    const updated = saveRecentSearch(searchQuery.trim());
                    setRecentSearches(updated);
                  }
                }}
                placeholder="SEARCH TRACKS, ALBUMS, ARTISTS..."
                autoComplete="off"
                spellCheck="false"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                >
                  <X size={14} strokeWidth={2.2} />
                </button>
              )}
            </div>
          </header>

          {/* Main Scrollable Content */}
          <main ref={contentRef} className="app-main-content">
        {/* View 1: Playlist Details View */}
        {isLoadingPlaylist ? (
          <div className="playlist-loading-view">
            <span className="loading-spinner large" />
            <p className="loading-label">Loading playlist tracks...</p>
          </div>
        ) : selectedPlaylist ? (
          <div className="playlist-detail-view">
            <div className="playlist-nav-bar">
              <button
                type="button"
                className="back-nav-btn"
                onClick={() => setSelectedPlaylist(null)}
              >
                <ArrowLeft size={16} strokeWidth={2} />
                <span>Back to Home</span>
              </button>
            </div>

            <header className="playlist-header">
              <div className="playlist-cover-wrap">
                <ArtworkImage
                  src={selectedPlaylist.thumbnailUrl}
                  alt={selectedPlaylist.title}
                  className="playlist-cover"
                  priority
                />
              </div>

              <div className="playlist-info">
                <span className="playlist-badge">PLAYLIST</span>
                <h1 className="playlist-title">{selectedPlaylist.title}</h1>
                <p className="playlist-meta">
                  <span className="playlist-author">{selectedPlaylist.author}</span>
                  {selectedPlaylist.trackCount && (
                    <>
                      <span className="meta-separator">•</span>
                      <span>{selectedPlaylist.trackCount}</span>
                    </>
                  )}
                  {selectedPlaylist.tracks.length > 0 && (
                    <>
                      <span className="meta-separator">•</span>
                      <span>{selectedPlaylist.tracks.length} songs</span>
                    </>
                  )}
                </p>

                {selectedPlaylist.description && (
                  <p className="playlist-description">
                    {selectedPlaylist.description}
                  </p>
                )}

                <div className="playlist-actions">
                  <button
                    type="button"
                    className="playlist-play-all-btn"
                    onClick={() => {
                      if (selectedPlaylist.tracks.length > 0) {
                        const first = selectedPlaylist.tracks[0];
                        selectTrack({
                          videoId: first.videoId,
                          title: first.title,
                          artist: first.artist,
                          thumbnailUrl: first.thumbnailUrl,
                          playlistId: selectedPlaylist.id,
                        });
                      }
                    }}
                    disabled={selectedPlaylist.tracks.length === 0}
                  >
                    <Play size={15} fill="currentColor" strokeWidth={0} />
                    <span>Play All</span>
                  </button>
                </div>
              </div>
            </header>

            <section className="playlist-tracks-section">
              <div className="tracklist-header-row">
                <span className="col-num">#</span>
                <span className="col-title">Title</span>
                <span className="col-artist">Artist</span>
                <span className="col-time">Duration</span>
              </div>

              <div className="tracklist-rows">
                {selectedPlaylist.tracks.map((track, idx) => {
                  const isTrackActive = currentTrack?.videoId === track.videoId;
                  return (
                    <div
                      key={track.videoId || idx}
                      className={`tracklist-row ${isTrackActive ? "active" : ""}`}
                      onClick={() => {
                        selectTrack({
                          videoId: track.videoId,
                          title: track.title,
                          artist: track.artist,
                          thumbnailUrl: track.thumbnailUrl,
                          playlistId: selectedPlaylist.id,
                        });
                      }}
                    >
                      <span className="col-num">
                        {isTrackActive ? (
                          <Play size={12} fill="currentColor" strokeWidth={0} />
                        ) : (
                          idx + 1
                        )}
                      </span>
                      <div className="col-title-wrap">
                        <ArtworkImage
                          src={track.thumbnailUrl}
                          videoId={track.videoId}
                          alt={track.title}
                          className="track-row-thumb"
                        />
                        <span className="track-row-title">{track.title}</span>
                      </div>
                      <span className="col-artist">{track.artist}</span>
                      <span className="col-time">{track.duration}</span>
                    </div>
                  );
                })}
              </div>

              {selectedPlaylist.tracks.length === 0 && (
                <p className="empty-message">No playable tracks found in this playlist.</p>
              )}
            </section>
          </div>
        ) : playlistError ? (
          <div className="playlist-error-view">
            <p className="empty-message">{playlistError}</p>
            <button
              type="button"
              className="back-nav-btn"
              onClick={() => setPlaylistError(null)}
            >
              <ArrowLeft size={16} strokeWidth={2} />
              <span>Back to Home</span>
            </button>
          </div>
        ) : searchQuery.trim().length > 0 ? (
          /* View 2: Redesigned Modern Search Page */
          <div className="search-view-container" aria-label="Search results">
            {/* Search Header Panel */}
            <div className="search-header-panel">
              <div className="search-header-meta">
                <span className="dot-red-accent" />
                <h2 className="search-header-title">
                  {isSearching ? "Searching..." : `Results for "${searchQuery}"`}
                </h2>
                {!isSearching && searchResults.length > 0 && (
                  <span className="search-count-badge">
                    {filteredSearchResults.length} {filteredSearchResults.length === 1 ? "item" : "items"}
                  </span>
                )}
              </div>

              <div className="search-header-actions">
                <div className="search-filter-pills">
                  <button
                    type="button"
                    className={`search-filter-pill ${searchFilter === "all" ? "active" : ""}`}
                    onClick={() => setSearchFilter("all")}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`search-filter-pill ${searchFilter === "song" ? "active" : ""}`}
                    onClick={() => setSearchFilter("song")}
                  >
                    <Music size={11} />
                    <span>Songs</span>
                  </button>
                  <button
                    type="button"
                    className={`search-filter-pill ${searchFilter === "playlist" ? "active" : ""}`}
                    onClick={() => setSearchFilter("playlist")}
                  >
                    <ListMusic size={11} />
                    <span>Playlists</span>
                  </button>
                </div>

                <button
                  type="button"
                  className="search-clear-action-btn"
                  onClick={() => setSearchQuery("")}
                  title="Clear search query"
                >
                  <X size={13} strokeWidth={2.2} />
                  <span>Clear</span>
                </button>
              </div>
            </div>

            {/* If actively searching, show animated shimmer skeletons */}
            {isSearching ? (
              <div className="search-cards-grid">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="search-skeleton-card">
                    <div className="skeleton-thumb-wrap">
                      <div className="carousel-shimmer-skeleton" />
                    </div>
                    <div className="skeleton-lines">
                      <div className="skeleton-line title" />
                      <div className="skeleton-line sub" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredSearchResults.length === 0 ? (
              /* Empty Search State */
              <div className="search-empty-state">
                <div className="search-empty-icon-wrap">
                  <SearchX size={34} strokeWidth={1.5} />
                </div>
                <h3 className="search-empty-title">No matches found</h3>
                <p className="search-empty-desc">
                  We couldn&apos;t find any results for &ldquo;{searchQuery}&rdquo;. Try checking your spelling or searching for another track.
                </p>
                <button
                  type="button"
                  className="search-empty-clear-btn"
                  onClick={() => setSearchQuery("")}
                >
                  Clear Search
                </button>
              </div>
            ) : (
              /* Search Results Content */
              <div className="search-results-content">
                {/* Top Match Spotlight (shown in "all" view) */}
                {searchFilter === "all" && filteredSearchResults.length > 0 && (
                  <div className="search-top-spotlight">
                    <span className="search-subheading-label">TOP MATCH</span>
                    <div
                      className="top-match-card"
                      onClick={() => handleCardClick(filteredSearchResults[0])}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="top-match-cover-wrap">
                        <ArtworkImage
                          src={filteredSearchResults[0].thumbnailUrl}
                          videoId={filteredSearchResults[0].videoId}
                          alt={filteredSearchResults[0].title}
                          className="top-match-cover"
                          priority
                        />
                        <button
                          type="button"
                          className="top-match-play-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCardClick(filteredSearchResults[0]);
                          }}
                          aria-label="Play Top Match"
                        >
                          <Play size={20} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />
                        </button>
                      </div>

                      <div className="top-match-meta">
                        <span className={`card-type-pill ${filteredSearchResults[0].itemType || "song"}`}>
                          {filteredSearchResults[0].itemType === "playlist" ? "PLAYLIST" : "SONG"}
                        </span>
                        <h3 className="top-match-title">{filteredSearchResults[0].title}</h3>
                        <p className="top-match-artist">{filteredSearchResults[0].artist}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Grid of Results */}
                <div className="search-grid-section">
                  {searchFilter === "all" && filteredSearchResults.length > 1 && (
                    <span className="search-subheading-label">MORE RESULTS</span>
                  )}
                  <div className="search-cards-grid">
                    {(searchFilter === "all"
                      ? filteredSearchResults.slice(1)
                      : filteredSearchResults
                    ).map((item, itemIdx) => {
                      const trackId = item.videoId || item.playlistId || String(itemIdx);
                      const isActive =
                        (currentTrack?.videoId && currentTrack.videoId === item.videoId) ||
                        (currentTrack?.playlistId && currentTrack.playlistId === item.playlistId);

                      return (
                        <button
                          key={trackId}
                          type="button"
                          className={`track-card ${isActive ? "active" : ""}`}
                          onClick={() => handleCardClick(item)}
                        >
                          <div className="card-thumb-wrap">
                            <ArtworkImage
                              src={item.thumbnailUrl}
                              videoId={item.videoId}
                              alt={item.title}
                            />
                            <span className={`card-type-pill ${item.itemType || "song"}`}>
                              {item.itemType === "playlist" ? "Playlist" : "Song"}
                            </span>
                            <span className="card-play-indicator">
                              <Play
                                size={13}
                                fill="currentColor"
                                strokeWidth={0}
                                style={{ marginLeft: 1 }}
                              />
                            </span>
                          </div>
                          <div className="card-meta">
                            <p className="card-title">{item.title}</p>
                            <p className="card-artist">{item.artist}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : activeNav === "history" ? (
          /* View 3: YouTube Music History Page */
          <div className="history-view-container" aria-label="Listening history">
            {/* Header */}
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
                  onClick={() => fetchHistory()}
                  disabled={isLoadingHistory}
                  title="Refresh history"
                >
                  <RefreshCw
                    size={13}
                    className={isLoadingHistory ? "history-spin" : ""}
                  />
                  <span>Refresh</span>
                </button>
              )}
            </div>

            {/* Recent Searches Section in History */}
            {recentSearches.length > 0 && (
              <div className="history-recent-searches-box">
                <div className="recent-searches-header">
                  <div className="recent-header-left">
                    <Clock size={13} className="recent-header-icon" />
                    <span className="recent-header-title">RECENT SEARCHES</span>
                    <span className="search-count-badge">
                      {recentSearches.length}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="clear-recent-btn"
                    onClick={handleClearAllRecentSearches}
                    title="Clear all recent searches"
                  >
                    <Trash2 size={12} />
                    <span>Clear All</span>
                  </button>
                </div>

                <div className="recent-chips-wrap">
                  {recentSearches.map((query) => (
                    <button
                      key={query}
                      type="button"
                      className="recent-search-chip"
                      onClick={() => handleSelectRecentSearch(query)}
                      title={`Search for "${query}"`}
                    >
                      <Clock size={11} className="chip-clock-icon" />
                      <span className="chip-query-text">{query}</span>
                      <span
                        role="button"
                        className="chip-remove-btn"
                        onClick={(e) => handleDeleteRecentSearch(e, query)}
                        title="Remove search"
                      >
                        <X size={11} strokeWidth={2.5} />
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Main History Feed from YouTube Music */}
            {!isLoggedIn ? (
              <div className="history-auth-prompt">
                <div className="history-auth-icon-wrap">
                  <History size={36} strokeWidth={1.5} />
                </div>
                <h3 className="history-auth-title">SYNC YOUR LISTENING HISTORY</h3>
                <p className="history-auth-desc">
                  Sign in with your YouTube Music account to stream and synchronize your listening history across all devices.
                </p>
                <button
                  type="button"
                  className="history-signin-btn"
                  disabled={isLoggingIn}
                  onClick={async () => {
                    setIsLoggingIn(true);
                    await openLoginWindow();
                  }}
                >
                  {isLoggingIn ? "CONNECTING..." : "CONNECT WITH YOUTUBE MUSIC"}
                </button>
              </div>
            ) : isLoadingHistory ? (
              <div className="history-shelves-loading">
                <div className="search-cards-grid">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="search-skeleton-card">
                      <div className="skeleton-thumb-wrap">
                        <div className="carousel-shimmer-skeleton" />
                      </div>
                      <div className="skeleton-lines">
                        <div className="skeleton-line title" />
                        <div className="skeleton-line sub" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : historySections.length === 0 ? (
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
                {historySections.map((section, sIdx) => (
                  <section key={sIdx} className="content-section">
                    <div className="section-header-row">
                      <span className="dot-red-accent small" />
                      <h2 className="section-heading">{section.title}</h2>
                      <span className="search-count-badge">
                        {section.items.length}
                      </span>
                    </div>
                    <div className="shelves-grid">
                      {section.items.map((item, itemIdx) => {
                        const trackId =
                          item.videoId || item.playlistId || `${sIdx}-${itemIdx}`;
                        const isActive =
                          (currentTrack?.videoId &&
                            currentTrack.videoId === item.videoId) ||
                          (currentTrack?.playlistId &&
                            currentTrack.playlistId === item.playlistId);

                        return (
                          <button
                            key={trackId}
                            type="button"
                            className={`track-card ${isActive ? "active" : ""}`}
                            onClick={() => handleCardClick(item)}
                          >
                            <div className="card-thumb-wrap">
                              <ArtworkImage
                                src={item.thumbnailUrl}
                                videoId={item.videoId}
                                alt={item.title}
                              />
                              <span
                                className={`card-type-pill ${item.itemType || "song"}`}
                              >
                                {item.itemType === "playlist"
                                  ? "Playlist"
                                  : "Song"}
                              </span>
                              <span className="card-play-indicator">
                                <Play
                                  size={13}
                                  fill="currentColor"
                                  strokeWidth={0}
                                  style={{ marginLeft: 1 }}
                                />
                              </span>
                            </div>
                            <div className="card-meta">
                              <p className="card-title">{item.title}</p>
                              <p className="card-artist">{item.artist}</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        ) : activeNav === "search" ? (
          /* View 4: Search Landing Page with Recent Searches & Recently Played */
          <div className="search-landing-container" aria-label="Search landing">
            {/* Recent Searches Section */}
            <div className="search-landing-card">
              <div className="recent-searches-header">
                <div className="recent-header-left">
                  <span className="dot-red-accent small" />
                  <h2 className="search-subheading-label">RECENT SEARCHES</h2>
                  {recentSearches.length > 0 && (
                    <span className="search-count-badge">
                      {recentSearches.length}
                    </span>
                  )}
                </div>
                {recentSearches.length > 0 && (
                  <button
                    type="button"
                    className="clear-recent-btn"
                    onClick={handleClearAllRecentSearches}
                    title="Clear all recent searches"
                  >
                    <Trash2 size={12} />
                    <span>Clear All</span>
                  </button>
                )}
              </div>

              {recentSearches.length > 0 ? (
                <div className="recent-chips-wrap">
                  {recentSearches.map((query) => (
                    <button
                      key={query}
                      type="button"
                      className="recent-search-chip"
                      onClick={() => handleSelectRecentSearch(query)}
                      title={`Search for "${query}"`}
                    >
                      <Clock size={11} className="chip-clock-icon" />
                      <span className="chip-query-text">{query}</span>
                      <span
                        role="button"
                        className="chip-remove-btn"
                        onClick={(e) => handleDeleteRecentSearch(e, query)}
                        title="Remove search"
                      >
                        <X size={11} strokeWidth={2.5} />
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="recent-empty-hint">
                  <Clock size={16} strokeWidth={1.5} />
                  <span>
                    No recent searches yet. Search for songs, artists, or playlists above.
                  </span>
                </div>
              )}
            </div>

            {/* Quick Recently Played Section from YouTube Music if available */}
            {isLoggedIn && historySections.length > 0 && (
              <section className="content-section" style={{ marginTop: 28 }}>
                <div className="section-header-row">
                  <span className="dot-red-accent small" />
                  <h2 className="section-heading">Recently Played on YouTube Music</h2>
                </div>
                <div className="shelves-grid">
                  {historySections[0].items.slice(0, 6).map((item, itemIdx) => {
                    const trackId =
                      item.videoId || item.playlistId || String(itemIdx);
                    const isActive =
                      (currentTrack?.videoId &&
                        currentTrack.videoId === item.videoId) ||
                      (currentTrack?.playlistId &&
                        currentTrack.playlistId === item.playlistId);

                    return (
                      <button
                        key={trackId}
                        type="button"
                        className={`track-card ${isActive ? "active" : ""}`}
                        onClick={() => handleCardClick(item)}
                      >
                        <div className="card-thumb-wrap">
                          <ArtworkImage
                            src={item.thumbnailUrl}
                            videoId={item.videoId}
                            alt={item.title}
                          />
                          <span
                            className={`card-type-pill ${item.itemType || "song"}`}
                          >
                            {item.itemType === "playlist" ? "Playlist" : "Song"}
                          </span>
                          <span className="card-play-indicator">
                            <Play
                              size={13}
                              fill="currentColor"
                              strokeWidth={0}
                              style={{ marginLeft: 1 }}
                            />
                          </span>
                        </div>
                        <div className="card-meta">
                          <p className="card-title">{item.title}</p>
                          <p className="card-artist">{item.artist}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        ) : (
          /* View 5: Personalized Home Feed Recommendations */
          <div className="home-shelves-container">
            {topPicksItems.length > 0 && (
              <TopPicksCarousel
                items={topPicksItems}
                onPlay={selectTrack}
                onOpenPlaylist={openPlaylist}
                currentTrackId={currentTrack?.videoId}
                isPlaying={playerState === "playing"}
              />
            )}

            {homeSections.slice(topPicksItems.length > 0 ? 1 : 0).map((section, idx) => (
              <section key={idx} className="content-section">
                <div className="section-header-row">
                  <span className="dot-red-accent small" />
                  <h2 className="section-heading">{section.title}</h2>
                </div>
                <div className="shelves-grid">
                  {section.items.map((item, itemIdx) => {
                    const trackId = item.videoId || item.playlistId || `${idx}-${itemIdx}`;
                    const isActive = (currentTrack?.videoId && currentTrack.videoId === item.videoId) ||
                      (currentTrack?.playlistId && currentTrack.playlistId === item.playlistId);
                    return (
                      <button
                        key={trackId}
                        type="button"
                        className={`track-card ${isActive ? "active" : ""}`}
                        onClick={() => handleCardClick(item)}
                      >
                        <div className="card-thumb-wrap">
                          <ArtworkImage
                            src={item.thumbnailUrl}
                            videoId={item.videoId}
                            alt={item.title}
                          />
                          <span className={`card-type-pill ${item.itemType || "song"}`}>
                            {item.itemType === "playlist" ? "Playlist" : "Song"}
                          </span>
                          <span className="card-play-indicator">
                            <Play size={13} fill="currentColor" strokeWidth={0} style={{ marginLeft: 1 }} />
                          </span>
                        </div>
                        <div className="card-meta">
                          <p className="card-title">{item.title}</p>
                          <p className="card-artist">{item.artist}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}

            {isLoadingMore && (
              <div className="shelves-loading-indicator">
                <span className="loading-spinner" />
                <span>Loading more recommendations...</span>
              </div>
            )}
          </div>
        )}
      </main>
    </div> {/* app-main-area */}
  </div> {/* app-body-container */}

      {/* Persistent Docked Music Player */}
      {currentTrack && (
        <>
          <HiddenYouTubePlayer
            key={
              currentTrack.playlistId
                ? `playlist-${currentTrack.playlistId}`
                : `track-${currentTrack.videoId}`
            }
            videoId={currentTrack.videoId}
            playlistId={currentTrack.playlistId}
            onReady={handlePlayerReady}
            onStateChange={handlePlayerStateChange}
            onError={handlePlayerError}
            onTrackChange={handleTrackChangeFromIframe}
          />

          <footer className="docked-player" aria-label="Audio player">
            {/* Left: Track Information */}
            <div className="player-track-info">
              <ArtworkImage
                src={currentTrack.thumbnailUrl}
                videoId={currentTrack.videoId}
                alt={currentTrack.title}
                className="player-thumb"
                priority
              />
              <div className="player-meta">
                <p className="player-title">{currentTrack.title}</p>
                <p className="player-artist">{currentTrack.artist}</p>
              </div>
            </div>

            {/* Center: Controls & Scrubber */}
            <div className="player-center-controls">
              <div className="player-buttons-row">
                <button
                  type="button"
                  className="player-skip-btn"
                  onClick={handlePreviousTrack}
                  disabled={!isPlayerReady}
                  aria-label="Previous track"
                  title="Previous"
                >
                  <SkipBack size={18} fill="currentColor" strokeWidth={1} />
                </button>

                <button
                  type="button"
                  className="player-main-btn"
                  onClick={() => {
                    if (playerState === "playing") {
                      playerRef.current?.pauseVideo();
                    } else {
                      if (playerState === "ended") {
                        playerRef.current?.seekTo(0, true);
                        setCurrentTime(0);
                      }
                      playerRef.current?.playVideo();
                    }
                  }}
                  disabled={!isPlayerReady || playerState === "buffering"}
                  aria-label={playerState === "playing" ? "Pause" : "Play"}
                  title={getPlayButtonLabel()}
                >
                  {playerState === "buffering" || !isPlayerReady ? (
                    <Loader2 size={16} className="spin-icon" />
                  ) : playerState === "playing" ? (
                    <Pause size={16} fill="currentColor" strokeWidth={0} />
                  ) : (
                    <Play size={16} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />
                  )}
                </button>

                <button
                  type="button"
                  className="player-skip-btn"
                  onClick={handleNextTrack}
                  disabled={!isPlayerReady}
                  aria-label="Next track"
                  title="Next"
                >
                  <SkipForward size={18} fill="currentColor" strokeWidth={1} />
                </button>
              </div>

              <div className="player-scrubber-row">
                <span className="time-display">{formatTime(currentTime)}</span>
                <input
                  type="range"
                  className="scrubber-slider"
                  min="0"
                  max={duration || 0}
                  step="0.1"
                  value={Math.min(currentTime, duration || 0)}
                  onPointerDown={() => {
                    isScrubbingRef.current = true;
                  }}
                  onChange={(event) => {
                    const nextTime = Number(event.target.value);
                    setCurrentTime(nextTime);
                    if (!isScrubbingRef.current) {
                      playerRef.current?.seekTo(nextTime, true);
                    }
                  }}
                  onPointerUp={(event) => {
                    isScrubbingRef.current = false;
                    const nextTime = Number(event.currentTarget.value);
                    playerRef.current?.seekTo(nextTime, true);
                  }}
                  onKeyUp={(event) => {
                    if (
                      event.key === "ArrowLeft" ||
                      event.key === "ArrowRight"
                    ) {
                      const nextTime = Number(event.currentTarget.value);
                      playerRef.current?.seekTo(nextTime, true);
                    }
                  }}
                  disabled={!isPlayerReady || duration <= 0}
                />
                <span className="time-display">{formatTime(duration)}</span>
              </div>
            </div>

            {/* Right: Status & Error Warning */}
            <div className="player-status-side">
              {playbackError ? (
                <span className="player-error-tag">{playbackError}</span>
              ) : (
                <span
                  className="player-state-pill"
                  data-state={isPlayerReady ? playerState : "loading"}
                >
                  <span className="pill-dot" />
                  {isPlayerReady
                    ? playerState === "playing"
                      ? "Playing"
                      : playerState === "buffering"
                        ? "Buffering"
                        : "Ready"
                    : "Loading"}
                </span>
              )}
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export default App;
