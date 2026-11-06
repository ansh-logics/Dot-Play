import { Clock, X } from "lucide-react";

interface RecentSearchChipsProps {
  searches: string[];
  onSelect: (query: string) => void;
  onDelete: (query: string) => void;
}

export function RecentSearchChips({ searches, onSelect, onDelete }: RecentSearchChipsProps) {
  return (
    <div className="recent-chips-wrap">
      {searches.map((query) => (
        <button
          key={query}
          type="button"
          className="recent-search-chip"
          onClick={() => onSelect(query)}
          onKeyDown={(e) => {
            // The × is a mouse target inside the chip; keyboard users remove it with Delete.
            if (e.key === "Delete" || e.key === "Backspace") {
              e.preventDefault();
              onDelete(query);
            }
          }}
          aria-keyshortcuts="Delete"
          aria-label={`Search for ${query}. Press Delete to remove it.`}
          title={`Search for "${query}"`}
        >
          <Clock size={11} className="chip-clock-icon" />
          <span className="chip-query-text">{query}</span>
          <span
            aria-hidden="true"
            className="chip-remove-btn"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(query);
            }}
            title="Remove search"
          >
            <X size={11} strokeWidth={2.5} />
          </span>
        </button>
      ))}
    </div>
  );
}
