import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion, useScroll, useTransform } from "motion/react";
import trayIcon from "../../../src-tauri/icons/tray-template@2x.png";

/** Screenshots of the app; the menu bar shot comes from `npm run capture`. */
const SHOTS = {
  home: "/shots/app-home.jpg",
  apple: "/shots/app-apple.jpg",
  nothing: "/shots/app-nothing.jpg",
  vinyl: "/shots/app-vinyl.jpg",
  queue: "/shots/app-queue.jpg",
  lyrics: "/shots/app-lyrics.jpg",
  menubar: "/shots/menubar-player.jpg",
};
const SHOT_SIZE = { width: 2000, height: 1256 };
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

function Copy({ kicker, title, children }: { kicker: string; title: ReactNode; children: ReactNode }) {
  return (
    <Reveal className="showcase-copy">
      <p className="kicker">
        <span className="red-dot" /> {kicker}
      </p>
      <h2 className="showcase-title">{title}</h2>
      <p className="showcase-text">{children}</p>
    </Reveal>
  );
}

/** The hero product shot: settles from a tilt to flat as it scrolls into view. */
export function HeroShot() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "center center"] });
  const rotateX = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [24, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], reduce ? [1, 1] : [0.9, 1]);
  return (
    <div ref={ref} className="hero-shot">
      <motion.div
        className="screen"
        style={{ rotateX, scale }}
        initial={{ opacity: 0, y: 60 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1.1, delay: 0.5, ease }}
      >
        <img src={SHOTS.home} alt="dot(.)music home: Top Picks and Quick Picks" width={1470} height={926} fetchPriority="high" />
      </motion.div>
      <div className="screen-glow" aria-hidden="true" />
    </div>
  );
}

const MOODS = [
  { id: "apple", label: "Apple", src: SHOTS.apple },
  { id: "nothing", label: "Nothing", src: SHOTS.nothing },
  { id: "vinyl", label: "Vinyl", src: SHOTS.vinyl },
] as const;

/** Three styles, cross-fading on their own while the section is on screen. */
function Moods() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % MOODS.length), 3200);
    return () => window.clearInterval(id);
  }, [inView, reduce]);

  return (
    <section className="showcase" id="features">
      <Copy kicker="Styles" title="Three moods. One player.">
        Spin the style wheel at the edge of the screen: Apple-style frosted glass, a stark Nothing look in dot-matrix, or a
        warm vinyl sleeve. Your album art sets the colours.
      </Copy>
      <Reveal className="mood-stage" delay={0.1}>
        <div ref={ref} className="screen">
          <AnimatePresence initial={false}>
            <motion.img
              key={MOODS[i].id}
              src={MOODS[i].src}
              alt={`The ${MOODS[i].label} style`}
              {...SHOT_SIZE}
              loading="lazy"
              initial={{ opacity: 0, scale: 1.02 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease }}
            />
          </AnimatePresence>
        </div>
        <div className="mood-labels" aria-hidden="true">
          {MOODS.map((m, n) => (
            <span key={m.id} className={n === i ? "is-on" : undefined}>
              {m.label}
            </span>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

/** Lyrics: a highlight sweeps across the headline the way the app sweeps words, then the real thing. */
function Lyrics() {
  return (
    <section className="showcase lyrics-show">
      <Reveal>
        <p className="kicker">
          <span className="red-dot" /> Lyrics
        </p>
        <h2 className="sweep-title">
          <span>Every word lights up</span> <span>as it's sung.</span>
        </h2>
        <p className="showcase-text centered">
          Word-by-word synced lyrics with backing vocals underneath and breathing dots for instrumental breaks. Hindi, Arabic,
          Tamil and every other script render properly.
        </p>
      </Reveal>
      <Reveal className="lyrics-stage" delay={0.1}>
        <div className="screen kenburns kenburns--lyrics">
          <img src={SHOTS.lyrics} alt="Synced Hindi lyrics for Ehsaas in the Apple style" {...SHOT_SIZE} loading="lazy" />
        </div>
      </Reveal>
    </section>
  );
}

function Vinyl() {
  return (
    <section className="showcase is-flipped">
      <Copy kicker="Vinyl" title="Spins up. Slows down. Like the real thing.">
        Press play and the tonearm drops, the platter eases up to speed and the album art turns on the label. Pause, and it
        coasts to a stop.
      </Copy>
      <Reveal className="vinyl-stage" delay={0.1}>
        <div className="screen kenburns">
          <img src={SHOTS.vinyl} alt="The Vinyl style with a spinning record" {...SHOT_SIZE} loading="lazy" />
        </div>
      </Reveal>
    </section>
  );
}

/** The queue sheet: a slow push-in, like the vinyl shot. */
function Queue() {
  return (
    <section className="showcase is-flipped">
      <Copy kicker="Queue" title="Up Next, without leaving the song.">
        Pull up the queue over Now Playing to reorder, remove or clear what's next, or jump back through your history.
        Autoplay keeps it full with fresh picks and never loops the same songs.
      </Copy>
      <Reveal className="vinyl-stage" delay={0.1}>
        <div className="screen kenburns">
          <img src={SHOTS.queue} alt="The Up Next queue over Now Playing" {...SHOT_SIZE} loading="lazy" />
        </div>
      </Reveal>
    </section>
  );
}

/** A Mac desktop; the menu bar player drops from its icon when the section comes into view. */
function MenuBar() {
  const ref = useRef<HTMLDivElement>(null);
  const open = useInView(ref, { once: true, amount: 0.5 });
  return (
    <section className="showcase">
      <Copy kicker="Menu bar" title="Your music, one click away.">
        A phone-style mini player lives in the menu bar: cover, scrubber, shuffle, repeat, volume, Up Next and live lyrics. It
        opens over full-screen apps, and media keys, AirPods and Control Center work too.
      </Copy>
      <Reveal className="desk-stage" delay={0.1}>
        <div ref={ref} className="desk">
          <div className="desk-bar" aria-hidden="true">
            <b>Finder</b>
            <span>File</span>
            <span>Edit</span>
            <span>View</span>
            <span className="desk-spacer" />
            <span className={`desk-icon ${open ? "is-on" : ""}`}>
              <img src={trayIcon} alt="" />
            </span>
            <span>9:41</span>
          </div>
          <motion.div
            className="desk-popover"
            initial={{ opacity: 0, y: -10, scale: 0.94 }}
            animate={open ? { opacity: 1, y: 0, scale: 1 } : undefined}
            transition={{ type: "spring", stiffness: 260, damping: 24, delay: 0.35 }}
          >
            <img src={SHOTS.menubar} alt="The menu bar mini player" width={640} height={1160} loading="lazy" />
          </motion.div>
        </div>
      </Reveal>
    </section>
  );
}

export function Showcase() {
  return (
    <>
      <Moods />
      <Lyrics />
      <Vinyl />
      <MenuBar />
      <Queue />
    </>
  );
}
