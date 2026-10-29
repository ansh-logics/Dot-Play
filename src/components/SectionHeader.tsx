/** Red dot, heading and an optional count badge above a shelf. */
export function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="section-header-row">
      <span className="dot-red-accent small" />
      <h2 className="section-heading">{title}</h2>
      {count !== undefined && <span className="search-count-badge">{count}</span>}
    </div>
  );
}
