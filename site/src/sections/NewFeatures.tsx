import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { OrbitMerge, type OrbitResult, type OrbitSong } from "@app/components/import/OrbitMerge";
import "@app/styles/import.css";

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

/** Made-up songs for the import demo (the orbit draws initials discs for songs without covers). */
const DEMO_SONGS: OrbitSong[] = [
  "Golden Hour Drive",
  "Paper Planes Home",
  "Velvet Static",
  "Northern Lights",
  "Lemonade Summer",
  "City After Rain",
  "Slow Motion Heart",
  "Coastline",
  "Midnight Bloom",
  "Neon Tide",
  "Satellite Love",
  "Afterglow",
  "Wildfire Season",
  "Blue Arcade",
  "Sunday Polaroid",
  "Echo Valley",
  "Glass Houses",
  "Late Night Radio",
].map((title, i) => ({ title, artist: `Artist ${i + 1}` }));

/** Songs "found" one by one at a believable pace, with the odd one not found. */
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
            // Two of each run's songs aren't found, so the "drifts away" path shows too.
            next[i] = (i + run) % 9 === 4 ? null : "";
            return next;
          }),
        700 + i * 260 + Math.random() * 400,
      ),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [run, active]);
  return results;
}

const IMPORT_SOURCES = ["Spotify", "Apple Music", "Deezer", "YouTube", "A song list"];

/** Playlist import: the app's own orbit animation, playing on a loop while it's on screen. */
export function ImportDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const [run, setRun] = useState(0);
  const [merged, setMerged] = useState(0);
  const active = inView && !reduce;
  const results = useDemoResults(run, active);
  const songs = useMemo(() => DEMO_SONGS.slice(), [run]); // a new list restarts the orbit
  const missing = results.filter((r) => r === null).length;

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
          {IMPORT_SOURCES.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      </Reveal>

      <Reveal className="import-stage" delay={0.1}>
        <div ref={ref} className="import-demo" aria-hidden={reduce ? undefined : "true"}>
          {reduce ? (
            <p className="import-demo-still">18 songs found · ready to play</p>
          ) : (
            <OrbitMerge
              key={run}
              songs={songs}
              results={results}
              onMerged={() => setMerged((n) => n + 1)}
              onSettled={() =>
                window.setTimeout(() => {
                  setMerged(0);
                  setRun((n) => n + 1);
                }, 1800)
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
