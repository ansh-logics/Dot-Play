import { Star } from "lucide-react";
import { RELEASES_URL, REPO_URL, type RepoInfo } from "../lib/github";

export function Logo() {
  return (
    <a href="#top" className="logo" aria-label="dot(.)music home">
      dot(<span className="logo-dot" />)music
    </a>
  );
}

export function StarButton({ stars, className = "" }: { stars: number | null; className?: string }) {
  return (
    <a className={`btn btn-ghost ${className}`} href={REPO_URL} target="_blank" rel="noreferrer">
      <Star size={16} />
      Star on GitHub
      {stars !== null && <span className="btn-count">{stars.toLocaleString()}</span>}
    </a>
  );
}

export function Nav({ info }: { info: RepoInfo }) {
  return (
    <header className="nav">
      <Logo />
      <nav className="nav-links" aria-label="Sections">
        <a href="#features">Features</a>
        <a href="#install">Install</a>
        <a href="#faq">FAQ</a>
      </nav>
      <div className="nav-actions">
        <StarButton stars={info.stars} className="hide-sm" />
        <a className="btn btn-red btn-sm" href={info.dmgUrl ?? RELEASES_URL}>
          Download
        </a>
      </div>
    </header>
  );
}
