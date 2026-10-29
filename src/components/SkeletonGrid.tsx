/** Shimmering placeholder cards shown while a grid loads. */
export function SkeletonGrid({ count }: { count: number }) {
  return (
    <div className="search-cards-grid">
      {Array.from({ length: count }).map((_, i) => (
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
  );
}
