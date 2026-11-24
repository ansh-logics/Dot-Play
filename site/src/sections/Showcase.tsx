import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { FeatureBento } from "../demos/Bento";
import { AlsoNew } from "./NewFeatures";

/**
 * A screenshot as WebP, with a 1000px copy for phones when the original is wider.
 * The JPEGs come from `npm run capture`; `npm run webp` makes these from them.
 */
function shot(name: string, fullWidth: number | null = 2000) {
  return {
    src: `/shots/${name}.webp`,
    srcSet: fullWidth ? `/shots/${name}-1000.webp 1000w, /shots/${name}.webp ${fullWidth}w` : undefined,
    sizes: fullWidth ? "(max-width: 1000px) 100vw, 1000px" : undefined,
  };
}

/** Screenshots of the app, from `npm run capture`. */
const SHOTS = {
  apple: shot("app-apple"),
  nothing: shot("app-nothing"),
  vinyl: shot("app-vinyl"),
  cassette: shot("app-cassette"),
  // Immersive mode, from `npm run capture`.
  immersiveApple: shot("immersive-apple"),
  immersiveNothing: shot("immersive-nothing"),
  immersiveVinyl: shot("immersive-vinyl"),
  immersiveLyrics: shot("immersive-lyrics"),
  immersivePortrait: shot("immersive-portrait", null),
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


const MOODS = [
  { id: "apple", label: "Apple", note: "Frosted glass in your album's colours." },
  { id: "nothing", label: "Nothing", note: "Stark, in dot matrix." },
  { id: "vinyl", label: "Vinyl", note: "A record that spins up and coasts to a stop." },
  { id: "cassette", label: "Cassette", note: "A hi-fi deck with piano keys and a tape counter." },
] as const;
const MOOD_SHOTS = { apple: SHOTS.apple, nothing: SHOTS.nothing, vinyl: SHOTS.vinyl, cassette: SHOTS.cassette };

/** The player styles as real screenshots. They advance on their own while on screen until the
 *  visitor picks one; then the choice stays. */
function Moods() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (!inView || reduce || picked) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % MOODS.length), 3600);
    return () => window.clearInterval(id);
  }, [inView, reduce, picked]);
  const mood = MOODS[i];

  return (
    <section className="showcase moods" id="styles">
      <Copy kicker="Styles" title="Four moods. One player.">
        Spin the style wheel at the edge of the screen and the whole player changes. Your album art sets the colours.
      </Copy>
      <Reveal className="mood-stage" delay={0.1}>
        <div className="mood-tabs" role="tablist" aria-label="Player style">
          {MOODS.map((m, n) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              id={`mood-tab-${m.id}`}
              aria-selected={n === i}
              aria-controls="mood-panel"
              className={n === i ? "is-on" : undefined}
              onClick={() => {
                setI(n);
                setPicked(true);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div ref={ref} className="screen" role="tabpanel" id="mood-panel" aria-labelledby={`mood-tab-${mood.id}`}>
          <AnimatePresence initial={false}>
            <motion.img
              key={mood.id}
              {...MOOD_SHOTS[mood.id]}
              alt={`dot(.)music in the ${mood.label} style`}
              {...SHOT_SIZE}
              loading="lazy"
              initial={{ opacity: 0, scale: 1.02 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7, ease }}
            />
          </AnimatePresence>
        </div>
        <p className="mood-note" aria-live="polite">
          <b>{mood.label}.</b> {mood.note}
        </p>
      </Reveal>
    </section>
  );
}

const CLOCKS = [
  { id: "apple", label: "Apple", shot: SHOTS.immersiveApple },
  { id: "nothing", label: "Nothing", shot: SHOTS.immersiveNothing },
  { id: "vinyl", label: "Vinyl", shot: SHOTS.immersiveVinyl },
] as const;

const IMMERSIVE_POINTS = [
  {
    title: "Every display, its own view",
    text: "The clock on one, big synced lyrics on another, the artwork on a third. Pick them in Settings or live with keys 1–9.",
  },
  {
    title: "A screensaver that plays along",
    text: "Leave the Mac for a few minutes while music plays and it fades in on its own. Touch anything and you're back.",
  },
  {
    title: "Made for every screen",
    text: "Portrait displays get a poster, ultrawides go side by side, and covers load at your display's full resolution.",
  },
  {
    title: "Press I",
    text: "Or the button in Now Playing, the sidebar or the menu bar. Esc steps back to the player.",
  },
];

/** Immersive mode on a desk of three displays; the middle one cycles the three styles. */
function Immersive() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % CLOCKS.length), 3400);
    return () => window.clearInterval(id);
  }, [inView, reduce]);

  const monitor = (delay: number) => ({
    initial: { opacity: 0, y: 40 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.3 },
    transition: { duration: 1, delay, ease },
  });

  return (
    <section className="showcase immersive-show" id="immersive">
      <Reveal>
        <p className="kicker">
          <span className="red-dot" /> Immersive mode · New in 1.1
        </p>
        <h2 className="showcase-title centered-title">Your desk becomes the stage.</h2>
        <p className="showcase-text centered">
          A big clock with the song that's playing, full screen across your displays, in your player style. Like a lock
          screen for your music.
        </p>
      </Reveal>

      <div ref={ref} className="monitors">
        <motion.figure className="monitor monitor--side" {...monitor(0.15)}>
          <div className="screen">
            <img {...SHOTS.immersiveLyrics} alt="Immersive mode: big synced lyrics on a second display" {...SHOT_SIZE} loading="lazy" />
          </div>
          <span className="monitor-stand" aria-hidden="true" />
        </motion.figure>
        <motion.figure className="monitor monitor--main" {...monitor(0)}>
          <div className="screen">
            <AnimatePresence initial={false}>
              <motion.img
                key={CLOCKS[i].id}
                {...CLOCKS[i].shot}
                alt={`Immersive mode: the clock and song in the ${CLOCKS[i].label} style`}
                {...SHOT_SIZE}
                loading="lazy"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.9, ease }}
              />
            </AnimatePresence>
          </div>
          <span className="monitor-stand" aria-hidden="true" />
        </motion.figure>
        <motion.figure className="monitor monitor--portrait" {...monitor(0.3)}>
          <div className="screen">
            <img {...SHOTS.immersivePortrait} alt="Immersive mode on a portrait display: the artwork as a poster" width={1100} height={1956} loading="lazy" />
          </div>
          <span className="monitor-stand" aria-hidden="true" />
        </motion.figure>
      </div>
      <div className="mood-labels" aria-hidden="true">
        {CLOCKS.map((c, n) => (
          <span key={c.id} className={n === i ? "is-on" : undefined}>
            {c.label}
          </span>
        ))}
      </div>

      <div className="immersive-points">
        {IMMERSIVE_POINTS.map((point, n) => (
          <Reveal key={point.title} delay={0.08 * n} className="immersive-point">
            <h3>{point.title}</h3>
            <p>{point.text}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}




function Features() {
  return (
    <section className="section features" id="features" aria-labelledby="features-title">
      <Reveal>
        <p className="kicker">
          <span className="red-dot" /> Everything else
        </p>
        <h2 id="features-title" className="section-title">
          Small app. Big on the details.
        </h2>
      </Reveal>
      <FeatureBento />
    </section>
  );
}

export function Showcase() {
  return (
    <>
      <Moods />
      <Features />
      <Immersive />
      <AlsoNew />
    </>
  );
}
