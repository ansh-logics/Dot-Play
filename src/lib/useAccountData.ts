import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getAuthStatus,
  getHistory,
  getHomeFeed,
  getHomeFeedContinuation,
  getLibraryPlaylists,
  getUserProfile,
  isTauriEnvironment,
  logoutUser,
  openLoginWindow,
  type HomeFeedResponse,
  type HomeSection,
  type SearchResult,
  type UserProfile,
} from "./search";
import { cacheTracks, clearAccountSpecificCache } from "./trackCache";

const cacheSections = (sections: HomeSection[]) => cacheTracks(sections.flatMap((s) => s.items));

interface AccountDataOptions {
  showToast: (message: string) => void;
  /** Home shelves stop loading more while a search is showing. */
  isSearchActive: boolean;
  /** Clears UI that belongs to the signed-out account (open playlist, tabs, queue history). */
  onSignedOut: () => void;
}

/** Sign-in state plus everything fetched from YouTube Music for the shelves. */
export function useAccountData({ showToast, isSearchActive, onSignedOut }: AccountDataOptions) {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authSyncError, setAuthSyncError] = useState<string | null>(null);
  const [homeSections, setHomeSections] = useState<HomeSection[]>([]);
  const [continuationToken, setContinuationToken] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [historySections, setHistorySections] = useState<HomeSection[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [librarySections, setLibrarySections] = useState<HomeSection[]>([]);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);

  const isRefreshingAuthRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const historyRequestRef = useRef(false);
  const libraryRequestRef = useRef(false);

  const applyHomeFeed = useCallback((res: HomeFeedResponse) => {
    setHomeSections(res.sections);
    setContinuationToken(res.continuationToken ?? null);
    cacheSections(res.sections);
  }, []);

  const refreshAuthSession = useCallback(async () => {
    if (isRefreshingAuthRef.current) return;
    isRefreshingAuthRef.current = true;
    setIsLoggingIn(false);
    setAuthSyncError(null);

    try {
      const authenticated = await getAuthStatus();
      if (!authenticated) {
        setIsLoggedIn(false);
        setUserProfile(null);
        return;
      }

      setIsLoggedIn(true);
      setIsLoadingLibrary(true);
      setIsLoadingHistory(true);

      const [profileRes, libraryRes, historyRes, homeRes] = await Promise.allSettled([
        getUserProfile(),
        getLibraryPlaylists(),
        getHistory(),
        getHomeFeed(),
      ]);

      if (profileRes.status === "fulfilled" && profileRes.value) {
        setUserProfile(profileRes.value);
      } else {
        console.warn("[DOT Music] Profile fetch returned empty or failed:", profileRes);
        setUserProfile(
          (prev) =>
            prev ?? { name: "YouTube Music Account", email: "Connected", avatarUrl: "" },
        );
      }

      if (libraryRes.status === "fulfilled") {
        setLibrarySections(libraryRes.value.sections);
        cacheSections(libraryRes.value.sections);
      } else {
        console.error("[DOT Music] Failed to fetch library playlists:", libraryRes.reason);
      }

      if (historyRes.status === "fulfilled") {
        setHistorySections(historyRes.value.sections);
        cacheSections(historyRes.value.sections);
      } else {
        console.error("[DOT Music] Failed to fetch history:", historyRes.reason);
      }

      if (homeRes.status === "fulfilled") {
        applyHomeFeed(homeRes.value);
      } else {
        console.error("[DOT Music] Failed to fetch home feed:", homeRes.reason);
      }
    } catch (err) {
      console.error("[DOT Music] Error during post-login auth refresh:", err);
      setAuthSyncError("Unable to sync account data. Tap to retry.");
      showToast("Account sync encountered an issue. Tap retry to refresh.");
    } finally {
      setIsLoadingLibrary(false);
      setIsLoadingHistory(false);
      isRefreshingAuthRef.current = false;
    }
  }, [applyHomeFeed, showToast]);

  const initiateLogin = useCallback(
    async (clean = false) => {
      setIsLoggingIn(true);
      setAuthSyncError(null);
      try {
        await openLoginWindow(clean);
      } catch (err) {
        console.error("[DOT Music] Failed to open login window:", err);
        setIsLoggingIn(false);
        showToast("Could not open sign-in window");
      }
    },
    [showToast],
  );

  const onSignedOutRef = useRef(onSignedOut);
  useEffect(() => {
    onSignedOutRef.current = onSignedOut;
  });

  const signOut = useCallback(async () => {
    setIsLoggingIn(false);
    setAuthSyncError(null);

    try {
      await logoutUser();
    } catch (e) {
      console.error("[DOT Music] Failed to logout:", e);
    }

    setIsLoggedIn(false);
    setUserProfile(null);
    setLibrarySections([]);
    setHistorySections([]);
    onSignedOutRef.current();

    // Account-specific library and playlist metadata goes from memory and disk;
    // preferences in localStorage stay.
    clearAccountSpecificCache();
    try {
      sessionStorage.clear();
    } catch {
      // ignore
    }

    try {
      applyHomeFeed(await getHomeFeed());
    } catch (e) {
      console.error("[DOT Music] Failed to fetch guest home feed:", e);
    }

    showToast("Signed out successfully.");
  }, [applyHomeFeed, showToast]);

  // Startup: load the account (or the guest feed) and listen for the login window.
  useEffect(() => {
    let isCancelled = false;
    const unlisteners: Array<() => void> = [];

    void getAuthStatus().then((status) => {
      if (isCancelled) return;
      if (status) {
        void refreshAuthSession();
        return;
      }
      setIsLoggedIn(false);
      setUserProfile(null);
      getHomeFeed()
        .then((res) => {
          if (!isCancelled) applyHomeFeed(res);
        })
        .catch((e) => console.error("[DOT Music] Failed to fetch guest home feed:", e));
    });

    if (isTauriEnvironment()) {
      const register = (event: string, handler: () => void) => {
        listen(event, () => {
          if (!isCancelled) handler();
        })
          .then((un) => {
            if (isCancelled) un();
            else unlisteners.push(un);
          })
          .catch((err) => {
            console.warn(`[DOT Music] Failed to register ${event} listener:`, err);
          });
      };
      register("login_success", () => void refreshAuthSession());
      register("login_cancelled", () => setIsLoggingIn(false));
    }

    return () => {
      isCancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, [applyHomeFeed, refreshAuthSession]);

  // Returning to the window after signing in elsewhere picks the account up.
  useEffect(() => {
    const handleWindowFocus = async () => {
      try {
        const status = await getAuthStatus();
        if (status && !isLoggedIn) {
          await refreshAuthSession();
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [isLoggedIn, refreshAuthSession]);

  // Failsafe poll while the login window is open.
  useEffect(() => {
    if (!isLoggingIn) return;
    const interval = setInterval(async () => {
      try {
        const status = await getAuthStatus();
        if (status) {
          clearInterval(interval);
          await refreshAuthSession();
        }
      } catch {
        // ignore
      }
    }, 600);
    return () => clearInterval(interval);
  }, [isLoggingIn, refreshAuthSession]);

  // A tab switch and its effect can both ask at once; one request is enough.
  const fetchHistory = useCallback(async () => {
    if (!isLoggedIn || historyRequestRef.current) return;
    historyRequestRef.current = true;
    setIsLoadingHistory(true);
    try {
      const res = await getHistory();
      setHistorySections(res.sections);
      cacheSections(res.sections);
    } catch (e) {
      console.error("Failed to fetch history:", e);
    } finally {
      historyRequestRef.current = false;
      setIsLoadingHistory(false);
    }
  }, [isLoggedIn]);

  const fetchLibrary = useCallback(async () => {
    if (!isLoggedIn || libraryRequestRef.current) return;
    libraryRequestRef.current = true;
    setIsLoadingLibrary(true);
    try {
      const res = await getLibraryPlaylists();
      setLibrarySections(res.sections);
      cacheSections(res.sections);
    } catch (e) {
      console.error("Failed to fetch library playlists:", e);
    } finally {
      libraryRequestRef.current = false;
      setIsLoadingLibrary(false);
    }
  }, [isLoggedIn]);

  const loadMoreShelves = useCallback(async () => {
    if (!continuationToken || isLoadingMoreRef.current || isSearchActive) return;

    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const res = await getHomeFeedContinuation(continuationToken);
      if (res.sections.length > 0) {
        cacheSections(res.sections);
        setHomeSections((prev) => {
          const existingTitles = new Set(prev.map((s) => s.title));
          const newUnique = res.sections.filter((s) => !existingTitles.has(s.title));
          return [...prev, ...(newUnique.length > 0 ? newUnique : res.sections)];
        });
      }
      setContinuationToken(res.continuationToken ?? null);
    } catch (err) {
      console.error("Failed to load more shelves:", err);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [continuationToken, isSearchActive]);

  /** Puts a just-played song at the top of the first history shelf (signed in only). */
  const addToHistory = useCallback(
    (track: SearchResult) => {
      if (!isLoggedIn) return;
      setHistorySections((prev) => {
        if (prev.length === 0) return [{ title: "Today", items: [track] }];
        const [first, ...rest] = prev;
        return [
          { ...first, items: [track, ...first.items.filter((i) => i.videoId !== track.videoId)] },
          ...rest,
        ];
      });
    },
    [isLoggedIn],
  );

  return {
    userProfile,
    isLoggedIn,
    isLoggingIn,
    authSyncError,
    homeSections,
    isLoadingMore,
    historySections,
    isLoadingHistory,
    librarySections,
    isLoadingLibrary,
    refreshAuthSession,
    initiateLogin,
    signOut,
    fetchHistory,
    fetchLibrary,
    loadMoreShelves,
    addToHistory,
  };
}
