import { useEffect, useState } from "react";

export const REPO = "ansh-logics/Dot-Play";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const ISSUES_URL = `${REPO_URL}/issues`;

export interface RepoInfo {
  stars: number | null;
  version: string | null;
  /** Direct link to the .dmg of the latest release, if there is one. */
  dmgUrl: string | null;
  dmgSizeMb: number | null;
}

const CACHE_KEY = "dm-site-github";
const CACHE_MS = 10 * 60 * 1000;
const EMPTY: RepoInfo = { stars: null, version: null, dmgUrl: null, dmgSizeMb: null };

function readCache(): RepoInfo | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { at, info } = JSON.parse(raw) as { at: number; info: RepoInfo };
    return Date.now() - at < CACHE_MS ? info : null;
  } catch {
    return null;
  }
}

async function fetchInfo(): Promise<RepoInfo> {
  const get = (path: string) =>
    fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: { Accept: "application/vnd.github+json" } }).then((r) =>
      r.ok ? r.json() : null,
    );
  const [repo, release] = await Promise.all([get("").catch(() => null), get("/releases/latest").catch(() => null)]);
  const dmg = (release?.assets as Array<{ name: string; size: number; browser_download_url: string }> | undefined)?.find((a) =>
    a.name.endsWith(".dmg"),
  );
  return {
    stars: typeof repo?.stargazers_count === "number" ? repo.stargazers_count : null,
    version: typeof release?.tag_name === "string" ? release.tag_name : null,
    dmgUrl: dmg?.browser_download_url ?? null,
    dmgSizeMb: dmg ? Math.round((dmg.size / 1024 / 1024) * 10) / 10 : null,
  };
}

/**
 * Live star count and latest release from the GitHub API (unauthenticated, cached for the
 * session). Everything degrades to plain links if the API is unavailable or rate-limited.
 */
export function useRepoInfo(): RepoInfo {
  const [info, setInfo] = useState<RepoInfo>(() => readCache() ?? EMPTY);
  useEffect(() => {
    if (readCache()) return;
    let cancelled = false;
    void fetchInfo().then((next) => {
      if (cancelled) return;
      setInfo(next);
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), info: next }));
      } catch {
        // storage unavailable: fine, just refetch next time
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
