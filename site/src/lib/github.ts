import { useEffect, useState } from "react";

export const REPO = "ansh-logics/Dot-Play";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const ISSUES_URL = `${REPO_URL}/issues`;
/** Fallback when the API is unavailable: Windows builds are the windows-v* pre-releases. */
export const WINDOWS_RELEASES_URL = `${REPO_URL}/releases`;

export type Platform = "mac" | "windows";

/** The visitor's computer, to put the matching download first. Everything else gets the Mac. */
export const VISITOR_PLATFORM: Platform =
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "windows" : "mac";

export interface RepoInfo {
  stars: number | null;
  version: string | null;
  /** Direct link to the .dmg of the latest release, if there is one. */
  dmgUrl: string | null;
  dmgSizeMb: number | null;
  /** The Windows app releases separately (windows-v* pre-releases), so it has its own version. */
  windowsVersion: string | null;
  /** Direct link to the latest Windows installer (.exe), if there is one. */
  exeUrl: string | null;
  exeSizeMb: number | null;
}

/** Download link, label details and fallback for one platform. */
export function downloadFor(info: RepoInfo, platform: Platform) {
  return platform === "windows"
    ? {
        url: info.exeUrl ?? WINDOWS_RELEASES_URL,
        label: "Download for Windows",
        version: info.windowsVersion,
        meta: `Windows 10 or 11 · 64-bit · ${info.exeSizeMb ? `${info.exeSizeMb} MB` : "~5 MB"}`,
      }
    : {
        url: info.dmgUrl ?? RELEASES_URL,
        label: "Download for Mac",
        version: info.version,
        meta: `macOS 13+ · Apple silicon · ${info.dmgSizeMb ? `${info.dmgSizeMb} MB` : "~7 MB"}`,
      };
}

const CACHE_KEY = "dm-site-github-v2";
const CACHE_MS = 10 * 60 * 1000;
const EMPTY: RepoInfo = {
  stars: null,
  version: null,
  dmgUrl: null,
  dmgSizeMb: null,
  windowsVersion: null,
  exeUrl: null,
  exeSizeMb: null,
};

interface Asset {
  name: string;
  size: number;
  browser_download_url: string;
}
interface Release {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  assets: Asset[];
}

const sizeMb = (asset: Asset | undefined) => (asset ? Math.round((asset.size / 1024 / 1024) * 10) / 10 : null);

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
  // Newest first. "latest" (the Mac release) never includes the Windows pre-releases.
  const [repo, release, releases] = await Promise.all([
    get("").catch(() => null),
    get("/releases/latest").catch(() => null) as Promise<Release | null>,
    get("/releases?per_page=30").catch(() => null) as Promise<Release[] | null>,
  ]);
  const dmg = release?.assets?.find((a) => a.name.endsWith(".dmg"));
  const windows = Array.isArray(releases)
    ? releases.find((r) => !r.draft && /^windows-v\d/.test(r.tag_name) && r.assets.some((a) => a.name.endsWith("-setup.exe")))
    : undefined;
  const exe = windows?.assets.find((a) => a.name.endsWith("-setup.exe"));
  return {
    stars: typeof repo?.stargazers_count === "number" ? repo.stargazers_count : null,
    version: typeof release?.tag_name === "string" ? release.tag_name : null,
    dmgUrl: dmg?.browser_download_url ?? null,
    dmgSizeMb: sizeMb(dmg),
    windowsVersion: windows ? windows.tag_name.replace(/^windows-/, "") : null,
    exeUrl: exe?.browser_download_url ?? null,
    exeSizeMb: sizeMb(exe),
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
