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
          title={`Search for "${query}"`}
        >
          <Clock size={11} className="chip-clock-icon" />
          <span className="chip-query-text">{query}</span>
          <span
            role="button"
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
