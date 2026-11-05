import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { OrbitMerge, type OrbitResult, type OrbitSong } from "@app/components/import/OrbitMerge";
import "@app/styles/import.css";
import { siApplemusic, siDeezer, siSpotify, siYoutubemusic, type SimpleIcon } from "simple-icons";

const ease = [0.22, 1, 0.36, 1] as const;

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 32 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.9, delay, ease }}
    >
      {children}
    </motion.div>
  );
}

const REMOTE_POINTS = [
  {
    title: "Any network",
    text: "Home Wi-Fi, office Wi-Fi or mobile data. Your phone and computer don't even need to be on the same network.",
  },
  {
    title: "Nothing to install",
    text: "Scan the QR code in Settings and the remote opens in your phone's browser. Add it to your Home Screen to keep it.",
  },
  {
    title: "Private by design",
    text: "Everything is end-to-end encrypted, and your computer asks before a new phone can connect. Disconnect it any time.",
  },
  {
    title: "The whole player",
    text: "Play, skip and seek, volume, live lyrics, Up Next, and search to play a song now, next or later.",
  },
];

/** The Phone Remote: two phones, Now Playing and Search, from the real remote page. */
export function Remote() {
  return (
    <section className="showcase remote-show" id="remote">
      <Reveal>
        <p className="kicker">
          <span className="red-dot" /> Phone Remote · New in 1.3
        </p>
        <h2 className="showcase-title centered-title">Your phone is the remote.</h2>
        <p className="showcase-text centered">
          Control dot(.)music from the couch, the kitchen or another room. Your phone shows what's playing, the lyrics and
          Up Next, and can search for the next song.
        </p>
      </Reveal>

      <div className="phones">
        <motion.figure
          className="phone phone--back"
          initial={{ opacity: 0, y: 50, rotate: -4 }}
          whileInView={{ opacity: 1, y: 0, rotate: -6 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 1, delay: 0.15, ease }}
        >
          <img src="/shots/remote-search.jpg" alt="The Phone Remote's search: play now, play next or add to Up Next" width={780} height={1688} loading="lazy" />
        </motion.figure>
        <motion.figure
          className="phone phone--front"
          initial={{ opacity: 0, y: 60 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 1, ease }}
        >
          <img src="/shots/remote-playing.jpg" alt="The Phone Remote showing the song that's playing" width={780} height={1688} loading="lazy" />
        </motion.figure>
      </div>

      <div className="immersive-points">
        {REMOTE_POINTS.map((point, n) => (
          <Reveal key={point.title} delay={0.08 * n} className="immersive-point">
            <h3>{point.title}</h3>
            <p>{point.text}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/** Well-known songs for the import demo. Their covers come from Apple's public iTunes search
 *  when the section comes into view, the same way the site's demo song gets its cover. */
const DEMO_SONGS: Array<[title: string, artist: string]> = [
  ["Blinding Lights", "The Weeknd"],
  ["Shape of You", "Ed Sheeran"],
  ["Levitating", "Dua Lipa"],
  ["As It Was", "Harry Styles"],
  ["bad guy", "Billie Eilish"],
  ["Flowers", "Miley Cyrus"],
  ["Anti-Hero", "Taylor Swift"],
  ["Kesariya", "Arijit Singh"],
  ["Uptown Funk", "Mark Ronson"],
  ["Espresso", "Sabrina Carpenter"],
  ["Believer", "Imagine Dragons"],
  ["Calm Down", "Rema"],
  ["Starboy", "The Weeknd"],
  ["Someone Like You", "Adele"],
  ["Die With A Smile", "Lady Gaga"],
  ["Viva La Vida", "Coldplay"],
  ["Tum Hi Ho", "Arijit Singh"],
  ["Peaches", "Justin Bieber"],
];

const COVER_CACHE = "dm-site-import-covers";

/** 300 px album covers for the demo songs, cached for the visit. Missing ones fall back to the
 *  orbit's own initials discs. */
async function loadDemoCovers(): Promise<Record<string, string>> {
  try {
    const cached = sessionStorage.getItem(COVER_CACHE);
    if (cached) return JSON.parse(cached);
  } catch {
    // ignore
  }
  const entries = await Promise.all(
    DEMO_SONGS.map(async ([title, artist]) => {
      try {
        const url = `https://itunes.apple.com/search?${new URLSearchParams({
          term: `${title} ${artist}`,
          entity: "song",
          limit: "1",
          country: "us",
        })}`;
        const data = (await (await fetch(url)).json()) as { results: Array<{ artworkUrl100?: string }> };
        const art = data.results[0]?.artworkUrl100;
        return art ? [title, art.replace(/\/\d+x\d+bb\.(jpg|png)$/, "/300x300bb.$1")] : null;
      } catch {
        return null;
      }
    }),
  );
  const covers = Object.fromEntries(entries.filter((e): e is [string, string] => e !== null));
  try {
    sessionStorage.setItem(COVER_CACHE, JSON.stringify(covers));
  } catch {
    // ignore
  }
  return covers;
}

/** The services an import can come from, with their logos (Simple Icons). */
const SOURCES = [
  { name: "Spotify", icon: siSpotify, playlist: "Road Trip Hits" },
  { name: "Apple Music", icon: siApplemusic, playlist: "Feel-Good Favourites" },
  { name: "Deezer", icon: siDeezer, playlist: "Sunday Morning" },
  { name: "YouTube Music", icon: siYoutubemusic, playlist: "Late Night Drive" },
] as const;

function BrandLogo({ icon, size = 18 }: { icon: SimpleIcon; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={`#${icon.hex}`} aria-hidden="true">
      <path d={icon.path} />
    </svg>
  );
}

/** Songs "found" one by one at a believable pace, with two of each run not found. */
function useDemoResults(run: number, active: boolean): OrbitResult[] {
  const [results, setResults] = useState<OrbitResult[]>(() => DEMO_SONGS.map(() => undefined));
  useEffect(() => {
    setResults(DEMO_SONGS.map(() => undefined));
    if (!active) return;
    const timers = DEMO_SONGS.map((_, i) =>
      window.setTimeout(
        () =>
          setResults((prev) => {
            const next = prev.slice();
            next[i] = (i + run * 5) % 9 === 4 ? null : "";
            return next;
          }),
        600 + i * 240 + Math.random() * 400,
      ),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [run, active]);
  return results;
}

/** Playlist import: the app's own orbit animation, playing on a loop while it's on screen, each
 *  run "importing" from the next service. */
export function ImportDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const near = useInView(ref, { amount: 0.1, margin: "300px 0px" });
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const [covers, setCovers] = useState<Record<string, string> | null>(null);
  const [run, setRun] = useState(0);
  const [merged, setMerged] = useState(0);

  // Covers load as the section approaches; the orbit starts once they're in (or failed).
  useEffect(() => {
    if (near && !covers) void loadDemoCovers().then(setCovers);
  }, [near, covers]);

  const active = inView && !reduce && covers !== null;
  const results = useDemoResults(run, active);
  const source = SOURCES[run % SOURCES.length];
  const songs = useMemo<OrbitSong[]>(
    () => DEMO_SONGS.map(([title, artist]) => ({ title, artist, cover: covers?.[title] })),
    // A new run gets a new list, which restarts the orbit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [covers, run],
  );
  const missing = results.filter((r) => r === null).length;
  // The "playlist cover": a different song's art each run, skipping any that didn't load.
  const available = DEMO_SONGS.map(([title]) => covers?.[title]).filter((c): c is string => Boolean(c));
  const lead = available.length > 0 ? available[(run * 5) % available.length] : undefined;

  return (
    <section className="showcase import-show" id="import">
      <Reveal className="showcase-copy">
        <p className="kicker">
          <span className="red-dot" /> Import · New in 1.3
        </p>
        <h2 className="showcase-title">Bring your playlists from anywhere.</h2>
        <p className="showcase-text">
          Paste a playlist link and watch every song spin into orbit and merge into the dot as it's found on YouTube Music.
          The playlist is kept on your computer with its name and cover, ready to play or save to your library.
        </p>
        <div className="source-chips" aria-label="Works with">
          {SOURCES.map((s, i) => (
            <span key={s.name} className={!reduce && i === run % SOURCES.length ? "is-on" : undefined}>
              <BrandLogo icon={s.icon} />
              {s.name}
            </span>
          ))}
          <span>A song list</span>
        </div>
      </Reveal>

      <Reveal className="import-stage" delay={0.1}>
        <div ref={ref} className="import-demo" aria-hidden={reduce ? undefined : "true"}>
          <div className="import-demo-head" key={`head-${run}`}>
            <span className="import-demo-cover">
              {lead && <img src={lead} alt="" />}
              <span className="import-demo-badge">
                <BrandLogo icon={source.icon} size={16} />
              </span>
            </span>
            <span className="import-demo-text">
              <span className="import-demo-from">Importing from {source.name}</span>
              <span className="import-demo-title">{source.playlist}</span>
              <span className="import-demo-meta">{DEMO_SONGS.length} songs</span>
            </span>
          </div>
          {reduce ? (
            <p className="import-demo-still">{DEMO_SONGS.length} songs found · ready to play</p>
          ) : (
            <OrbitMerge
              key={`orbit-${run}`}
              songs={songs}
              results={results}
              onMerged={() => setMerged((n) => n + 1)}
              onSettled={() =>
                window.setTimeout(() => {
                  setMerged(0);
                  setRun((n) => n + 1);
                }, 1400)
              }
            />
          )}
          {!reduce && (
            <p className="import-counter">
              <strong>{merged}</strong> / {songs.length} merged
              {missing > 0 && <span className="import-counter-missing"> · {missing} not found</span>}
            </p>
          )}
        </div>
      </Reveal>
    </section>
  );
}

const MORE = [
  {
    title: "Like and save",
    text: "Heart a song from the player, the sidebar or the menu bar, and save it to any playlist or a new one.",
  },
  {
    title: "Album pages",
    text: "Albums and playlists open full width, washed in the colours of their cover.",
  },
  {
    title: "Lyrics you can trust",
    text: "Lyrics without real timing show as text from the top. Out of sync on a song? Switch it to text and it stays that way.",
  },
  {
    title: "Mac and Windows",
    text: "The same player on both, with updates that install themselves.",
  },
];

/** Smaller things that landed recently. */
export function AlsoNew() {
  return (
    <section className="showcase also-new">
      <Reveal>
        <p className="kicker">
          <span className="red-dot" /> Also new
        </p>
        <h2 className="showcase-title centered-title">And a few more things.</h2>
      </Reveal>
      <div className="immersive-points">
        {MORE.map((point, n) => (
          <Reveal key={point.title} delay={0.08 * n} className="immersive-point">
            <h3>{point.title}</h3>
            <p>{point.text}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
