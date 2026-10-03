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
  SearchX,
  Music,
  ListMusic,
  History,
  Clock,
  Trash2,
  RefreshCw,
  UserPlus,
  HelpCircle,
  Settings,
  MoreVertical,
  Volume2,
  VolumeX,
  User,
  Maximize2,
  GripVertical,
} from "lucide-react";
import {
  searchTracks,
  openLoginWindow,
  getAuthStatus,
  logoutUser,
  getHomeFeed,
  getHomeFeedContinuation,
  getPlaylistDetails,
  getLibraryPlaylists,
  getUserProfile,
  getHistory,
  getRecentSearches,
  saveRecentSearch,
  removeRecentSearch,
  clearRecentSearches,
  recordPlayback,
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
  const [librarySections, setLibrarySections] = useState<HomeSection[]>([]);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);

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

  // Featured playlists extracted from home feed
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
  const [isMuted, setIsMuted] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [showQueue, setShowQueue] = useState(false);

  // Active playback queue with localStorage persistence
  const [queueTracks, setQueueTracks] = useState<SearchResult[]>(() => {
    try {
      const raw = localStorage.getItem("dot_music_queue");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.error("Failed to load queue from localStorage:", e);
    }
    return [];
  });

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Active playback queue fallback based on active context
  const contextQueue = useMemo(() => {
    if (selectedPlaylist && selectedPlaylist.tracks.length > 0) {
      return selectedPlaylist.tracks;
    }
    for (const section of homeSections) {
      const idx = section.items.findIndex(
        (i) => i.videoId === currentTrack?.videoId,
      );
      if (idx !== -1) {
        return section.items.filter((i) => Boolean(i.videoId));
      }
    }
    for (const section of historySections) {
      const idx = section.items.findIndex(
        (i) => i.videoId === currentTrack?.videoId,
      );
      if (idx !== -1) {
        return section.items.filter((i) => Boolean(i.videoId));
      }
    }
    if (searchResults.some((i) => i.videoId === currentTrack?.videoId)) {
      return searchResults.filter((i) => Boolean(i.videoId));
    }
    return currentTrack ? [currentTrack] : [];
  }, [
    selectedPlaylist,
    homeSections,
    historySections,
    searchResults,
    currentTrack,
  ]);

  // Synchronize queueTracks when switching playlists/albums/tracks or on initial load
  useEffect(() => {
    if (contextQueue.length > 0) {
      const hasCurrent = queueTracks.some((t) => t.videoId === currentTrack?.videoId);
      if (!hasCurrent || queueTracks.length === 0) {
        setQueueTracks(contextQueue);
        try {
          localStorage.setItem("dot_music_queue", JSON.stringify(contextQueue));
        } catch {}
      }
    }
  }, [contextQueue, currentTrack]);

  const handleReorderQueue = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    setQueueTracks((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      try {
        localStorage.setItem("dot_music_queue", JSON.stringify(next));
      } catch (err) {
        console.error("Failed to save queue to localStorage:", err);
      }
      return next;
    });
  };

  const activeQueue = queueTracks.length > 0 ? queueTracks : contextQueue;

  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const isScrubbingRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const playerStateRef = useRef<YouTubePlaybackState>("unstarted");
  const recordedTrackIdRef = useRef<string | null>(null);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    playerStateRef.current = playerState;
  }, [playerState]);

  const toggleMute = () => {
    if (!playerRef.current) return;
    if (isMuted) {
      playerRef.current.unMute?.();
      setIsMuted(false);
    } else {
      playerRef.current.mute?.();
      setIsMuted(true);
    }
  };
  const shouldAutoPlayRef = useRef(false);
  const contentRef = useRef<HTMLElement>(null);
  const isLoadingMoreRef = useRef(false);
  const handleNextTrackRef = useRef<() => void>(() => {});
  const profileMenuRef = useRef<HTMLDivElement>(null);

  const togglePlayPause = useCallback(() => {
    if (!playerRef.current || !isPlayerReady) return;
    if (playerStateRef.current === "playing") {
      playerRef.current.pauseVideo();
    } else {
      if (playerStateRef.current === "ended") {
        playerRef.current.seekTo(0, true);
        setCurrentTime(0);
      }
      playerRef.current.playVideo();
    }
  }, [isPlayerReady]);

  const seekRelative = useCallback((deltaSeconds: number) => {
    if (!playerRef.current || !isPlayerReady) return;
    const current = currentTimeRef.current;
    const total = durationRef.current;
    const target = Math.max(0, Math.min(total > 0 ? total : 999999, current + deltaSeconds));
    playerRef.current.seekTo(target, true);
    setCurrentTime(target);
  }, [isPlayerReady]);

  // Global Keyboard Shortcuts (Space: Play/Pause, Left/Right: Seek -5s/+5s, /: Focus Search, Esc: Dismiss)
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      if (!target || !(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        target.isContentEditable ||
        target.getAttribute("role") === "textbox"
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Esc: Dismiss modals, menus, back navigation or blur search
      if (e.key === "Escape") {
        if (showSettingsModal) {
          setShowSettingsModal(false);
          e.preventDefault();
          return;
        }
        if (showSupportModal) {
          setShowSupportModal(false);
          e.preventDefault();
          return;
        }
        if (showProfileMenu) {
          setShowProfileMenu(false);
          e.preventDefault();
          return;
        }
        if (showQueue) {
          setShowQueue(false);
          e.preventDefault();
          return;
        }
        if (selectedPlaylist) {
          setSelectedPlaylist(null);
          e.preventDefault();
          return;
        }
        if (document.activeElement === searchInputRef.current) {
          searchInputRef.current?.blur();
          e.preventDefault();
          return;
        }
      }

      // Ignore playback/navigation shortcuts if user is typing
      if (isTyping(e.target)) return;

      // 2. Space: Play / Pause
      if (e.code === "Space") {
        e.preventDefault();
        togglePlayPause();
        return;
      }

      // 3. ArrowLeft: Seek -5s
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekRelative(-5);
        return;
      }

      // 4. ArrowRight: Seek +5s
      if (e.key === "ArrowRight") {
        e.preventDefault();
        seekRelative(5);
        return;
      }

      // 5. / : Focus Search
      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
        if (activeNav !== "search") {
          setActiveNav("search");
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    showSettingsModal,
    showSupportModal,
    showProfileMenu,
    showQueue,
    selectedPlaylist,
    activeNav,
    togglePlayPause,
    seekRelative,
  ]);

  // Dismiss profile popup on outside click
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
    window.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
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
        getLibraryPlaylists().then((res) => {
          setLibrarySections(res.sections);
          cacheTracks(res.sections.flatMap((s) => s.items));
        });
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
        getLibraryPlaylists().then((res) => {
          setLibrarySections(res.sections);
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

  const fetchLibrary = useCallback(async () => {
    if (!isLoggedIn) return;
    setIsLoadingLibrary(true);
    try {
      const res = await getLibraryPlaylists();
      setLibrarySections(res.sections);
      cacheTracks(res.sections.flatMap((s) => s.items));
    } catch (e) {
      console.error("Failed to fetch library playlists:", e);
    } finally {
      setIsLoadingLibrary(false);
    }
  }, [isLoggedIn]);

  // Fetch library when navigating to library
  useEffect(() => {
    if (activeNav === "library" && isLoggedIn && librarySections.length === 0) {
      fetchLibrary();
    }
  }, [activeNav, isLoggedIn, librarySections.length, fetchLibrary]);

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

  const handlePlayerStateChange = useCallback(
    (state: YouTubePlaybackState) => {
      setPlayerState(state);
      if (state === "playing") {
        setPlaybackError(null);
      } else if (state === "ended") {
        // Record completed playback to YouTube Music history if not yet recorded
        if (currentTrack && currentTrack.videoId && recordedTrackIdRef.current !== currentTrack.videoId) {
          recordedTrackIdRef.current = currentTrack.videoId;
          recordPlayback(currentTrack.videoId, durationRef.current, currentTimeRef.current);
          if (isLoggedIn) {
            setHistorySections((prev) => {
              if (prev.length === 0) return [{ title: "Today", items: [currentTrack] }];
              const updated = [...prev];
              const first = { ...updated[0] };
              const filtered = first.items.filter((i) => i.videoId !== currentTrack.videoId);
              first.items = [currentTrack, ...filtered];
              updated[0] = first;
              return updated;
            });
          }
        }
        handleNextTrackRef.current();
      }
    },
    [currentTrack, isLoggedIn],
  );

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

  // 4b. Record playback to YouTube Music history once 10 seconds of playback threshold is met
  useEffect(() => {
    if (!currentTrack || !currentTrack.videoId) return;

    if (currentTime >= 10 && recordedTrackIdRef.current !== currentTrack.videoId) {
      recordedTrackIdRef.current = currentTrack.videoId;
      recordPlayback(currentTrack.videoId, duration, currentTime);

      // Optimistically push track into the top of the history list if logged in
      if (isLoggedIn) {
        setHistorySections((prev) => {
          if (prev.length === 0) {
            return [{ title: "Today", items: [currentTrack] }];
          }
          const updated = [...prev];
          const first = { ...updated[0] };
          const filtered = first.items.filter((i) => i.videoId !== currentTrack.videoId);
          first.items = [currentTrack, ...filtered];
          updated[0] = first;
          return updated;
        });
      }
    }
  }, [currentTime, currentTrack, duration, isLoggedIn]);

  // 5. Track Selection
  const selectTrack = (track: SearchResult) => {
    recordedTrackIdRef.current = null;
    const isSamePlaylist = Boolean(
      track.playlistId &&
        currentTrack?.playlistId &&
        track.playlistId === currentTrack.playlistId,
    );

    setCurrentTrack(track);
    cacheTrack(track);
    setCurrentTime(0);
    setPlaybackError(null);

    setQueueTracks((prev) => {
      const exists = prev.some((t) => t.videoId === track.videoId);
      if (!exists && track.videoId) {
        const next = [track, ...prev];
        try {
          localStorage.setItem("dot_music_queue", JSON.stringify(next));
        } catch {}
        return next;
      }
      return prev;
    });

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
        setQueueTracks(details.tracks);
        try {
          localStorage.setItem("dot_music_queue", JSON.stringify(details.tracks));
        } catch {}
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

        recordedTrackIdRef.current = null;

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
      // 1. Follow custom / reordered queue first
      if (queueTracks.length > 0) {
        const idx = queueTracks.findIndex(
          (t) => t.videoId === currentTrack.videoId,
        );
        if (idx !== -1 && idx < queueTracks.length - 1) {
          const next = queueTracks[idx + 1];
          setCurrentTrack({
            videoId: next.videoId,
            title: next.title,
            artist: next.artist,
            thumbnailUrl: next.thumbnailUrl,
            playlistId: next.playlistId || currentTrack.playlistId,
            itemType: "song",
          });
          return;
        }
      }

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
  }, [queueTracks, selectedPlaylist, currentTrack, homeSections, searchResults]);

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
      // 1. Follow custom / reordered queue first
      if (queueTracks.length > 0) {
        const idx = queueTracks.findIndex(
          (t) => t.videoId === currentTrack.videoId,
        );
        if (idx > 0) {
          const prevTrack = queueTracks[idx - 1];
          setCurrentTrack({
            videoId: prevTrack.videoId,
            title: prevTrack.title,
            artist: prevTrack.artist,
            thumbnailUrl: prevTrack.thumbnailUrl,
            playlistId: prevTrack.playlistId || currentTrack.playlistId,
            itemType: "song",
          });
          return;
        }
      }

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
  }, [currentTime, queueTracks, selectedPlaylist, currentTrack, homeSections, searchResults]);

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
              className={`sidebar-nav-item ${activeNav === "library" && !selectedPlaylist ? "active" : ""}`}
              onClick={() => {
                setActiveNav("library");
                setSearchQuery("");
                setSelectedPlaylist(null);
                if (isLoggedIn && librarySections.length === 0) {
                  fetchLibrary();
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

            {/* General Navigation Group (Image 2) */}
            <span className="nav-group-label">GENERAL</span>
            <button
              type="button"
              className={`sidebar-nav-item ${showSupportModal ? "active" : ""}`}
              onClick={() => setShowSupportModal(true)}
            >
              <span className="nav-item-indicator" />
              <HelpCircle size={17} strokeWidth={2} className="nav-svg-icon" />
              <span className="nav-item-label">Support</span>
            </button>

            <button
              type="button"
              className={`sidebar-nav-item ${showSettingsModal ? "active" : ""}`}
              onClick={() => setShowSettingsModal(true)}
            >
              <span className="nav-item-indicator" />
              <Settings size={17} strokeWidth={2} className="nav-svg-icon" />
              <span className="nav-item-label">Settings</span>
            </button>
          </nav>

          {/* Sidebar Mini Player Card (Image 1) */}
          {currentTrack && (
            <div
              className={`sidebar-player-card ${showQueue ? "queue-mode" : "hero-mode"}`}
              aria-label="Audio Player"
            >
              <div className={`sidebar-player-header ${showQueue ? "queue-view" : "hero-view"}`}>
                <div
                  className="sidebar-artwork-container"
                  onClick={() => setShowQueue((prev) => !prev)}
                  role="button"
                  tabIndex={0}
                  title={showQueue ? "Click to expand album artwork" : "Click to view upcoming queue"}
                >
                  <ArtworkImage
                    src={currentTrack.thumbnailUrl}
                    videoId={currentTrack.videoId}
                    alt={currentTrack.title}
                    className="sidebar-player-thumb"
                    priority
                  />
                  <span className="sidebar-artwork-hint-badge">
                    {showQueue ? <Maximize2 size={11} /> : <ListMusic size={11} />}
                  </span>
                </div>
                <div className="sidebar-player-meta">
                  <span className="sidebar-player-title" title={currentTrack.title}>
                    {currentTrack.title}
                  </span>
                  <span
                    className={`sidebar-player-artist ${playbackError ? "error" : ""}`}
                    title={playbackError || currentTrack.artist}
                  >
                    {playbackError || currentTrack.artist}
                  </span>
                </div>
              </div>

              <div className="sidebar-player-progress-wrap">
                <input
                  type="range"
                  className="sidebar-player-scrubber"
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
                  disabled={!isPlayerReady || duration <= 0}
                  aria-label="Seek track"
                />
                <div className="sidebar-player-times">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>

              <div className="sidebar-player-controls">
                <button
                  type="button"
                  className={`sidebar-ctrl-btn volume ${isMuted ? "active-muted" : ""}`}
                  onClick={toggleMute}
                  title={isMuted ? "Unmute" : "Mute"}
                  aria-label="Toggle mute"
                >
                  {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>

                <button
                  type="button"
                  className="sidebar-ctrl-btn"
                  onClick={handlePreviousTrack}
                  disabled={!isPlayerReady}
                  title="Previous track"
                  aria-label="Previous"
                >
                  <SkipBack size={15} fill="currentColor" />
                </button>

                <button
                  type="button"
                  className="sidebar-ctrl-btn play-pause"
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
                  title={getPlayButtonLabel()}
                  aria-label={playerState === "playing" ? "Pause" : "Play"}
                >
                  {playerState === "buffering" || !isPlayerReady ? (
                    <Loader2 size={15} className="spin-icon" />
                  ) : playerState === "playing" ? (
                    <Pause size={15} fill="currentColor" strokeWidth={0} />
                  ) : (
                    <Play size={15} fill="currentColor" strokeWidth={0} style={{ marginLeft: 1 }} />
                  )}
                </button>

                <button
                  type="button"
                  className="sidebar-ctrl-btn"
                  onClick={handleNextTrack}
                  disabled={!isPlayerReady}
                  title="Next track"
                  aria-label="Next"
                >
                  <SkipForward size={15} fill="currentColor" />
                </button>

                <button
                  type="button"
                  className={`sidebar-ctrl-btn queue ${showQueue ? "active" : ""}`}
                  onClick={() => {
                    setShowQueue((prev) => !prev);
                  }}
                  title={showQueue ? "Hide queue" : "Show upcoming queue"}
                  aria-label="Upcoming queue"
                >
                  <ListMusic size={15} />
                </button>
              </div>

              {/* Scrollable Queue Section inside Player Card */}
              <div className={`sidebar-player-queue ${showQueue ? "open" : "collapsed"}`}>
                <div className="sidebar-queue-inner">
                  <div className="sidebar-queue-header">
                    <span className="sidebar-queue-title">UPCOMING QUEUE</span>
                    <span className="sidebar-queue-count">
                      {activeQueue.length} {activeQueue.length === 1 ? "track" : "tracks"}
                    </span>
                  </div>
                  <div className="sidebar-queue-list">
                    {activeQueue.length === 0 ? (
                      <div className="sidebar-queue-empty">Queue is empty</div>
                    ) : (
                      activeQueue.map((track, qIdx) => {
                        const isCurrentPlaying = currentTrack.videoId === track.videoId;
                        return (
                          <div
                            key={track.videoId || qIdx}
                            className={`sidebar-queue-item ${isCurrentPlaying ? "active" : ""} ${draggedIndex === qIdx ? "dragging" : ""} ${dragOverIndex === qIdx ? "drag-over" : ""}`}
                            onClick={() => selectTrack(track)}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", String(qIdx));
                              setDraggedIndex(qIdx);
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              if (dragOverIndex !== qIdx) {
                                setDragOverIndex(qIdx);
                              }
                            }}
                            onDragLeave={() => {
                              if (dragOverIndex === qIdx) {
                                setDragOverIndex(null);
                              }
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              const sourceIdx = Number(e.dataTransfer.getData("text/plain"));
                              if (!Number.isNaN(sourceIdx) && sourceIdx !== qIdx) {
                                handleReorderQueue(sourceIdx, qIdx);
                              }
                              setDraggedIndex(null);
                              setDragOverIndex(null);
                            }}
                            onDragEnd={() => {
                              setDraggedIndex(null);
                              setDragOverIndex(null);
                            }}
                            role="button"
                            tabIndex={0}
                            title="Drag to reorder queue"
                          >
                            <div
                              className="sidebar-queue-drag-handle"
                              title="Drag to reorder"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <GripVertical size={11} />
                            </div>
                            <ArtworkImage
                              src={track.thumbnailUrl}
                              videoId={track.videoId}
                              alt={track.title}
                              className="sidebar-queue-thumb"
                            />
                            <div className="sidebar-queue-meta">
                              <span className="sidebar-queue-item-title" title={track.title}>
                                {track.title}
                              </span>
                              <span className="sidebar-queue-item-artist" title={track.artist}>
                                {track.artist}
                              </span>
                            </div>
                            {isCurrentPlaying && (
                              <span className="sidebar-queue-active-dot" />
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* User Account Card at Bottom of Sidebar (Image 2) */}
          <div className="sidebar-account-container" ref={profileMenuRef}>
            {/* Frosted Floating Profile Popover */}
            {showProfileMenu && (
              <div className="apple-profile-popover" role="dialog" aria-label="Account details">
                {isLoggedIn && (
                  <div className="popover-user-row">
                    {userProfile?.avatarUrl ? (
                      <img
                        src={userProfile.avatarUrl}
                        alt={userProfile.name}
                        className="popover-avatar"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="popover-avatar-placeholder">
                        <User size={16} />
                      </div>
                    )}
                    <div className="popover-user-text">
                      <span className="popover-user-name">{userProfile?.name || "Connected Account"}</span>
                      {userProfile?.email && (
                        <span className="popover-user-email">{userProfile.email}</span>
                      )}
                    </div>
                  </div>
                )}

                <div className="popover-badge-row">
                  <span className={`popover-status-badge ${isLoggedIn ? "online" : "offline"}`}>
                    <span className={`nothing-status-dot ${isLoggedIn ? "online" : "offline"}`} />
                    <span>{isLoggedIn ? "YouTube Music" : "Offline"}</span>
                  </span>
                </div>

                <div className="popover-divider" />

                <div className="popover-actions">
                  {isLoggedIn ? (
                    <>
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
                    </>
                  ) : (
                    <button
                      type="button"
                      className="popover-switch-btn"
                      disabled={isLoggingIn}
                      onClick={async () => {
                        setShowProfileMenu(false);
                        setIsLoggingIn(true);
                        await openLoginWindow(false);
                      }}
                    >
                      <UserPlus size={14} strokeWidth={2} />
                      <span>{isLoggingIn ? "CONNECTING..." : "Sign In with Google"}</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            <div
              className={`sidebar-account-card ${isLoggedIn ? "connected" : "guest"}`}
              onClick={() => {
                if (isLoggedIn) {
                  setShowProfileMenu((prev) => !prev);
                } else {
                  setIsLoggingIn(true);
                  openLoginWindow(false);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label="Account details"
            >
              <div className="account-avatar-wrapper">
                {userProfile?.avatarUrl ? (
                  <img
                    src={userProfile.avatarUrl}
                    alt={userProfile.name}
                    className="account-avatar-img"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="account-avatar-fallback">
                    <User size={18} strokeWidth={1.8} />
                  </div>
                )}
                <span className={`account-status-indicator ${isLoggedIn ? "online" : "offline"}`} />
              </div>

              <div className="account-details-col">
                <span className="account-display-name">
                  {isLoggedIn ? (userProfile?.name || "Connected User") : "Sign In"}
                </span>
                <span className="account-sub-label">
                  {isLoggedIn ? (userProfile?.email || "YouTube Music") : "Personalize feed & history"}
                </span>
              </div>

              <button
                type="button"
                className="account-dots-btn"
                aria-label="Account options"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowProfileMenu((prev) => !prev);
                }}
              >
                <MoreVertical size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
        </aside>

        {/* Right Main Content Area */}
        <div className="app-main-area">
          {/* Top Bar with Search */}
          <header className="app-top-bar">
            <div className="top-search-wrap">
              <Search size={16} strokeWidth={2.2} className="top-search-svg" />
              <input
                ref={searchInputRef}
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
        ) : activeNav === "library" ? (
          /* View 4: Liked & Saved Playlists / Library Page */
          <div className="library-view-container" aria-label="Playlists and library">
            {/* Header */}
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
                  onClick={() => fetchLibrary()}
                  disabled={isLoadingLibrary}
                  title="Refresh library playlists"
                >
                  <RefreshCw
                    size={13}
                    className={isLoadingLibrary ? "history-spin" : ""}
                  />
                  <span>Refresh</span>
                </button>
              )}
            </div>

            {/* Guest mode unauthenticated notice if not signed in */}
            {!isLoggedIn && (
              <div className="history-auth-prompt" style={{ margin: "16px 0 24px" }}>
                <div className="history-auth-icon-wrap">
                  <Library size={28} strokeWidth={1.8} />
                </div>
                <h3 className="history-auth-title">SYNC YOUR SAVED PLAYLISTS</h3>
                <p className="history-auth-desc">
                  Sign in with your Google account to access your Liked Music, custom playlists, and saved albums in one click.
                </p>
                <button
                  type="button"
                  className="history-signin-btn"
                  disabled={isLoggingIn}
                  onClick={() => {
                    setIsLoggingIn(true);
                    openLoginWindow(false);
                  }}
                >
                  <UserPlus size={14} />
                  <span>{isLoggingIn ? "CONNECTING..." : "Sign In with Google"}</span>
                </button>
              </div>
            )}

            {/* User Library Playlists Sections */}
            {isLoggedIn && isLoadingLibrary && librarySections.length === 0 ? (
              <div className="history-loading-view" style={{ padding: "40px 0", textAlign: "center" }}>
                <span className="loading-spinner large" />
                <p className="loading-label" style={{ marginTop: 12 }}>Loading your saved playlists...</p>
              </div>
            ) : (
              librarySections.map((section, idx) => (
                <section key={idx} className="content-section">
                  <div className="section-header-row">
                    <span className="dot-red-accent small" />
                    <h2 className="section-heading">{section.title}</h2>
                  </div>
                  <div className="shelves-grid">
                    {section.items.map((item, itemIdx) => {
                      const trackId = item.videoId || item.playlistId || `${idx}-${itemIdx}`;
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
                            <span className={`card-type-pill ${item.itemType || "playlist"}`}>
                              {item.itemType === "song" ? "Song" : "Playlist"}
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
              ))
            )}

            {/* Featured & Recommended Playlists */}
            {featuredPlaylists.length > 0 && (
              <section className="content-section" style={{ marginTop: 20 }}>
                <div className="section-header-row">
                  <span className="dot-red-accent small" />
                  <h2 className="section-heading">Featured & Recommended Playlists</h2>
                </div>
                <div className="shelves-grid">
                  {featuredPlaylists.slice(0, 12).map((item, itemIdx) => {
                    const trackId = item.playlistId || item.videoId || `feat-${itemIdx}`;
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
                          <span className="card-type-pill playlist">Playlist</span>
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

      {/* Hidden Audio Stream Engine */}
      {currentTrack && (
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
      )}

      {/* Settings Modal (Image 2) */}
      {showSettingsModal && (
        <div className="nothing-modal-backdrop" onClick={() => setShowSettingsModal(false)}>
          <div className="nothing-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="nothing-modal-header">
              <div className="nothing-modal-title-row">
                <Settings size={18} strokeWidth={2} className="modal-title-icon" />
                <h3 className="nothing-modal-title">SETTINGS</h3>
              </div>
              <button
                type="button"
                className="nothing-modal-close-btn"
                onClick={() => setShowSettingsModal(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="nothing-modal-body">
              <div className="settings-section">
                <span className="settings-section-title">AUDIO ENGINE</span>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-label">Stream Quality</span>
                    <span className="settings-desc">High Definition WebM/Opus audio streaming</span>
                  </div>
                  <span className="settings-badge">256 KBPS</span>
                </div>
              </div>

              <div className="settings-section">
                <span className="settings-section-title">DATA & STORAGE</span>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-label">Track & Artwork Cache</span>
                    <span className="settings-desc">Optimized WebP local cache for fast loading</span>
                  </div>
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={() => {
                      localStorage.clear();
                      window.location.reload();
                    }}
                  >
                    Clear Cache
                  </button>
                </div>
              </div>

              <div className="settings-section">
                <span className="settings-section-title">ACCOUNT</span>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="settings-label">Status</span>
                    <span className="settings-desc">
                      {isLoggedIn ? (userProfile?.email || "Connected to YouTube Music") : "Offline (Guest Mode)"}
                    </span>
                  </div>
                  <span className={`settings-status-pill ${isLoggedIn ? "online" : "offline"}`}>
                    {isLoggedIn ? "CONNECTED" : "OFFLINE"}
                  </span>
                </div>
              </div>

              <div className="settings-section">
                <span className="settings-section-title">ABOUT</span>
                <div className="settings-about-box">
                  <span className="about-app-name">dot(.)music</span>
                  <span className="about-app-ver">Version 0.1.0 • Nothing OS Minimalist Design</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Support Modal (Image 2) */}
      {showSupportModal && (
        <div className="nothing-modal-backdrop" onClick={() => setShowSupportModal(false)}>
          <div className="nothing-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="nothing-modal-header">
              <div className="nothing-modal-title-row">
                <HelpCircle size={18} strokeWidth={2} className="modal-title-icon" />
                <h3 className="nothing-modal-title">SUPPORT & SHORTCUTS</h3>
              </div>
              <button
                type="button"
                className="nothing-modal-close-btn"
                onClick={() => setShowSupportModal(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="nothing-modal-body">
              <div className="settings-section">
                <span className="settings-section-title">KEYBOARD SHORTCUTS</span>
                <div className="shortcuts-grid">
                  <div className="shortcut-item">
                    <kbd>Space</kbd>
                    <span>Play / Pause</span>
                  </div>
                  <div className="shortcut-item">
                    <kbd>←</kbd> <kbd>→</kbd>
                    <span>Seek -5s / +5s</span>
                  </div>
                  <div className="shortcut-item">
                    <kbd>/</kbd>
                    <span>Focus Search</span>
                  </div>
                  <div className="shortcut-item">
                    <kbd>Esc</kbd>
                    <span>Dismiss Popups & Modals</span>
                  </div>
                </div>
              </div>

              <div className="settings-section">
                <span className="settings-section-title">HELP & COMMUNITY</span>
                <p className="support-desc">
                  dot(.)music is a lightweight desktop client for YouTube Music built with Tauri and React, featuring an OLED-black aesthetic.
                </p>
                <div className="support-links">
                  <a
                    href="https://music.youtube.com"
                    target="_blank"
                    rel="noreferrer"
                    className="support-link-btn"
                  >
                    Open YouTube Music Web
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
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
