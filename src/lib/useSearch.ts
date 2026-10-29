import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearRecentSearches,
  getRecentSearches,
  removeRecentSearch,
  saveRecentSearch,
  searchTracks,
  type SearchResult,
} from "./search";
import { cacheTracks } from "./trackCache";

export type SearchFilter = "all" | "song" | "playlist";

const SEARCH_DEBOUNCE_MS = 350;

/** Live, debounced search plus the recent-searches list. */
export function useSearch() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFilter, setSearchFilter] = useState<SearchFilter>("all");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>(getRecentSearches);

  const filteredSearchResults = useMemo(() => {
    if (searchFilter === "all") return searchResults;
    return searchResults.filter((item) => (item.itemType || "song") === searchFilter);
  }, [searchResults, searchFilter]);

  useEffect(() => {
    const cleanQuery = searchQuery.trim();
    if (!cleanQuery) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    // A slower, older request must not overwrite the results of a newer query.
    let isStale = false;
    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const results = await searchTracks(cleanQuery);
        if (isStale) return;
        setSearchResults(results);
        cacheTracks(results);
        if (results.length > 0) {
          setRecentSearches(saveRecentSearch(cleanQuery));
        }
      } catch {
        if (!isStale) setSearchResults([]);
      } finally {
        if (!isStale) setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      isStale = true;
      clearTimeout(timer);
    };
  }, [searchQuery]);

  const rememberSearch = useCallback((query: string) => {
    const clean = query.trim();
    if (clean) setRecentSearches(saveRecentSearch(clean));
  }, []);

  const selectRecentSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setRecentSearches(saveRecentSearch(query));
  }, []);

  const deleteRecentSearch = useCallback((query: string) => {
    setRecentSearches(removeRecentSearch(query));
  }, []);

  const clearAllRecentSearches = useCallback(() => {
    clearRecentSearches();
    setRecentSearches([]);
  }, []);

  return {
    searchQuery,
    setSearchQuery,
    searchFilter,
    setSearchFilter,
    isSearching,
    searchResults,
    filteredSearchResults,
    recentSearches,
    rememberSearch,
    selectRecentSearch,
    deleteRecentSearch,
    clearAllRecentSearches,
  };
}
