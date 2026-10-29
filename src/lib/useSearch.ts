import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const NO_RESULTS: SearchResult[] = [];

/** Live, debounced search plus the recent-searches list. */
export function useSearch() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFilter, setSearchFilter] = useState<SearchFilter>("all");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>(getRecentSearches);

  // An empty query shows nothing; derived here rather than reset from an effect.
  const hasQuery = searchQuery.trim().length > 0;
  const visibleResults = hasQuery ? searchResults : NO_RESULTS;

  const filteredSearchResults = useMemo(() => {
    if (searchFilter === "all") return visibleResults;
    return visibleResults.filter((item) => (item.itemType || "song") === searchFilter);
  }, [visibleResults, searchFilter]);

  const queryRef = useRef(searchQuery);
  const handleQueryChange = useCallback((query: string) => {
    // The same query again starts no new request, so it must not show the spinner either.
    if (query === queryRef.current) return;
    queryRef.current = query;
    setSearchQuery(query);
    // Show the loading state straight away; the request itself is debounced below.
    setIsSearching(query.trim().length > 0);
  }, []);

  useEffect(() => {
    const cleanQuery = searchQuery.trim();
    if (!cleanQuery) return;

    // A slower, older request must not overwrite the results of a newer query.
    let isStale = false;
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
    handleQueryChange(query);
    setRecentSearches(saveRecentSearch(query));
  }, [handleQueryChange]);

  const deleteRecentSearch = useCallback((query: string) => {
    setRecentSearches(removeRecentSearch(query));
  }, []);

  const clearAllRecentSearches = useCallback(() => {
    clearRecentSearches();
    setRecentSearches([]);
  }, []);

  return {
    searchQuery,
    setSearchQuery: handleQueryChange,
    searchFilter,
    setSearchFilter,
    isSearching: hasQuery && isSearching,
    searchResults: visibleResults,
    filteredSearchResults,
    recentSearches,
    rememberSearch,
    selectRecentSearch,
    deleteRecentSearch,
    clearAllRecentSearches,
  };
}
