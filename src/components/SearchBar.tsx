import { memo } from "react";
import { Search, X } from "lucide-react";

interface SearchBarProps {
  ref: React.Ref<HTMLInputElement>;
  query: string;
  onQueryChange: (query: string) => void;
  onClear: () => void;
  onFocus: () => void;
  /** Enter keeps the query in recent searches. */
  onSubmit: (query: string) => void;
}

export const SearchBar = memo(function SearchBar({
  ref,
  query,
  onQueryChange,
  onClear,
  onFocus,
  onSubmit,
}: SearchBarProps) {
  return (
    <header className="app-top-bar">
      <div className="top-search-wrap">
        <Search size={16} strokeWidth={2.2} className="top-search-svg" />
        <input
          ref={ref}
          type="text"
          className="top-search-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={onFocus}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit(query);
          }}
          placeholder="Search songs, albums, artists"
          autoComplete="off"
          spellCheck="false"
        />
        {query && (
          <button type="button" className="search-clear-btn" onClick={onClear} aria-label="Clear search">
            <X size={14} strokeWidth={2.2} />
          </button>
        )}
      </div>
    </header>
  );
});
