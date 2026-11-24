import { Heart, History, House, ListMusic, Pause, Search, Settings, SkipBack, SkipForward } from "lucide-react";
import { Bar, Segmented, Stage, Window, type Act } from "../kit";
import "./hero-demo.css";

// The homepage hero: dot(.)music's Now Playing, dark, at 1:1.
//
// Story ("Your music. Every mood."): a song is playing and its lyrics light up
// word by word. The cursor picks Vinyl in the style switcher and the cover
// becomes a spinning record; then Nothing, and the lyrics go to dot-matrix
// with the app's red; then back to Apple, which is the frame the loop opens on.
// The lyrics run as a conveyor of six lines, so when the loop restarts the
// first line is sung again with nothing rewinding in view.
//
// Real strings: the song, the artist, the lyrics, the four style names.
// Everything else (sidebar, search, up next) is bars. Lyrics are original.

type Style = "apple" | "nothing" | "vinyl";
type S = { line: number; word: number; style: Style };

const LYRICS = [
  "Turn the city lights down low",
  "every street a different song",
  "hold the moment, let it glow",
  "we were singing all along",
  "windows down, nowhere to go",
  "the radio still keeps us warm",
];
const WORDS = LYRICS.map((l) => l.split(" "));
const STYLES = ["Apple", "Nothing", "Vinyl", "Cassette"];
const STYLE_INDEX: Record<Style, number> = { apple: 0, nothing: 1, vinyl: 2 };

const initial: S = { line: 0, word: 0, style: "apple" };
/** Where the cursor rests between loops: on the empty bar beside the switcher. */
const REST = { at: "style-apple", x: -0.9, y: 0.5 };
const WORD_MS = 300;
const LINE_GAP_MS = 520;

async function script(a: Act<S>) {
  // The singing runs under everything the cursor does, one word at a time, and
  // stops after the sixth line, on the opening frame of the next loop.
  let done!: () => void;
  const sung = new Promise<void>((r) => (done = r));
  (async () => {
    try {
      for (let line = 0; line < LYRICS.length; line++) {
        for (let w = 1; w <= WORDS[line].length; w++) {
          await a.wait(WORD_MS);
          a.put({ word: w });
        }
        await a.wait(LINE_GAP_MS);
        a.put({ line: line + 1, word: 0 });
      }
    } catch {
      /* stopped */
    }
    done();
  })();

  await a.wait(2200);

  a.mark("vinyl");
  await a.move({ at: "style-vinyl" });
  await a.wait(200);
  await a.click();
  a.set({ style: "vinyl" });
  await a.wait(3600);

  a.mark("nothing");
  await a.move({ at: "style-nothing" });
  await a.wait(200);
  await a.click();
  a.set({ style: "nothing" });
  await a.wait(3200);

  a.mark("apple");
  await a.move({ at: "style-apple" });
  await a.wait(200);
  await a.click();
  a.set({ style: "apple" });
  // Off the control to rest on the bar, where the loop opens
  await a.wait(500);
  await a.move(REST);
  await sung;
  // The conveyor has come round: line 6 looks exactly like line 0
  await a.snap({ line: 0, word: 0 });
}

function Lyrics({ s, compact }: { s: S; compact: boolean }) {
  // Rendered twice over so the line after the last is the first again
  const rows = [...LYRICS, ...LYRICS.slice(0, 4)];
  return (
    <div className="dmh-lyrics" data-compact={compact || undefined}>
      <div className="dmh-lyrics__track" data-snap style={{ transform: `translateY(calc(var(--dmh-line) * ${-s.line}))` }}>
        {rows.map((_, i) => {
          const words = WORDS[i % LYRICS.length];
          const state = i < s.line ? "past" : i === s.line ? "now" : "next";
          return (
            <div key={i} className="dmh-line" data-state={state}>
              {words.map((w, j) => (
                <span key={j} className="dmh-word" data-sung={(state === "past" || (state === "now" && j < s.word)) || undefined}>
                  {w}{" "}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The sleeve. In Vinyl it shrinks into the record's label as the record
 *  arrives; the label turns with the record, so leaving Vinyl never snaps a
 *  rotation back. */
function Art({ className, label }: { className: string; label?: boolean }) {
  return (
    <span className={`dmh-art ${className}`}>
      <span className="dmh-art__sun" />
      {!label && <span className="dmh-art__hill" />}
    </span>
  );
}

function Cover() {
  return (
    <div className="dmh-cover">
      <span className="dmh-record" aria-hidden>
        <Art className="dmh-art--label" label />
        <span className="dmh-record__hole" />
      </span>
      <Art className="dmh-art--sleeve" />
    </div>
  );
}

function Sidebar() {
  const nav = [
    { icon: <House size={15} />, w: 38, on: true },
    { icon: <Search size={15} />, w: 44 },
    { icon: <ListMusic size={15} />, w: 52 },
    { icon: <History size={15} />, w: 46 },
    { icon: <Settings size={15} />, w: 50 },
  ];
  return (
    <div className="dmh-side">
      <div className="dmh-logo">
        dot(<span className="dmh-logo__dot" />)music
      </div>
      <Bar w={46} h={4} tone={2} className="dmh-side__label" />
      {nav.map((n, i) => (
        <div key={i} className="dmh-nav" data-on={n.on || undefined}>
          {n.icon}
          <Bar w={n.w} h={5} tone={n.on ? 4 : 2} />
        </div>
      ))}
      <div className="dmh-mini">
        <span className="dmh-mini__art" />
        <Bar w={72} h={5} tone={4} />
        <Bar w={48} h={4} tone={2} />
      </div>
    </div>
  );
}

export function HeroDemo() {
  return (
    <Stage
      width={1080}
      height={560}
      compact={{ below: 760, width: 358, height: 470 }}
      initial={initial}
      poster={{ line: 1, word: 3, style: "vinyl" }}
      script={script}
      theme="dark"
      accent="#d71921"
      cursor={{ at: REST }}
      className="dmh"
    >
      {(s, _rect, layout) => {
        const compact = layout === "compact";
        return (
          <Window
            className="dmh-window"
            data-style={s.style}
            data-layout={layout}
            sidebar={compact ? undefined : <Sidebar />}
            sidebarWidth={196}
            lead={
              <Segmented
                className="dmh-seg"
                items={STYLES}
                value={STYLE_INDEX[s.style]}
                targets={["style-apple", "style-nothing", "style-vinyl", undefined]}
                cursor="pointer"
              />
            }
          >
            <div className="dmh-now">
              <div className="dmh-left">
                <Cover />
                <div className="dmh-meta">
                  <div className="dmh-title">Night Drive</div>
                  <div className="dmh-artist">Mira Sol</div>
                </div>
                <div className="dmh-scrub">
                  <span className="dmh-scrub__fill" />
                </div>
                <div className="dmh-controls">
                  <SkipBack size={16} fill="currentColor" strokeWidth={0} />
                  <span className="dmh-play">
                    <Pause size={15} fill="currentColor" strokeWidth={0} />
                  </span>
                  <SkipForward size={16} fill="currentColor" strokeWidth={0} />
                  <Heart size={15} className="dmh-heart" />
                </div>
              </div>
              <Lyrics s={s} compact={compact} />
            </div>
          </Window>
        );
      }}
    </Stage>
  );
}
