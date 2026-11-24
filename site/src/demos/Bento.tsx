import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, useInView, useReducedMotion } from "motion/react";
import { BatteryFull, Check, Heart, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward, Wifi } from "lucide-react";
import { siApplemusic, siDeezer, siSpotify, siYoutubemusic, type SimpleIcon } from "simple-icons";
import trayIcon from "../../../src-tauri/icons/tray-template@2x.png";
import { Bar, Button, Card, Connector, Count, Meter, Phone, Popover, Spinner, Stage, Toggle, Window, type Act } from "../kit";
import "./bento.css";

/* A feature grid as one picture: one hero tile (the Phone Remote), a number,
   and three small tiles that each do one thing once as they scroll in.
   Copy is page HTML above each picture; every picture is its own Stage at 1:1.
   No real string repeats from tile to tile, and none repeats the hero above. */

// ---------------------------------------------------------------- Remote

type RemoteS = { allowed: boolean };

async function remoteScript(a: Act<RemoteS>) {
  await a.wait(1600);
  await a.move({ at: "allow" });
  await a.wait(250);
  await a.click();
  a.set({ allowed: true });
  await a.wait(600);
  await a.move({ at: "allow", x: 0.5, y: 2.6 });
}

function RemoteScreen({ live }: { live: boolean }) {
  return (
    <div className="bx-remote" data-live={live || undefined}>
      <div className="bx-remote__head">
        <span className="bx-remote__dot" />
        dot(.)music
      </div>
<div className="bx-remote__art" />
      <div className="bx-remote__song">
        <div>
          <div className="bx-remote__title">Paper Moons</div>
          <div className="bx-remote__artist">Kavi Rao</div>
        </div>
        <Heart size={30} fill="currentColor" strokeWidth={0} className="bx-remote__heart" />
      </div>
      <div className="bx-remote__scrub">
        <span />
      </div>
      <div className="bx-remote__controls">
        <Shuffle size={26} />
        <SkipBack size={34} fill="currentColor" strokeWidth={0} />
        <span className="bx-remote__play">
          <Pause size={36} fill="currentColor" strokeWidth={0} />
        </span>
        <SkipForward size={34} fill="currentColor" strokeWidth={0} />
        <Repeat size={26} />
      </div>
      <div className="bx-remote__wait" aria-hidden={live || undefined}>
        <Spinner />
        <span>Waiting for your Mac</span>
      </div>
    </div>
  );
}

export function RemoteTile() {
  return (
    <Stage
      width={780}
      height={420}
      compact={{ below: 700, width: 358, height: 360 }}
      initial={{ allowed: false }}
      poster={{ allowed: true }}
      script={remoteScript}
      play="once"
      theme="dark"
      accent="#d71921"
      cursor={{ at: { at: "allow", x: -1.4, y: 1.6 } }}
      className="bx bx--remote"
    >
      {(s, _rect, layout) => {
        const compact = layout === "compact";
        return (
          <>
            <Window title="Settings" className="bx-settings">
              <div className="bx-set">
                <div className="bx-set__head">
                  <span className="bx-set__title">Phone Remote</span>
                  <Toggle on />
                </div>
                <div className="bx-set__desc">
                  <Bar w={compact ? 210 : 300} h={5} tone={2} />
                  <Bar w={compact ? 150 : 220} h={5} tone={2} />
                </div>
                <Card tone="sunken" className="bx-ask" data-target="ask">
                  <div className="bx-ask__row">
                    <span className="bx-ask__glyph" />
                    <span className="bx-ask__title">iPhone wants to connect</span>
                  </div>
                  <div className="bx-ask__actions">
                    <Button variant="ghost">Not now</Button>
                    <Button variant="primary" data-target="allow" icon={s.allowed ? <Check size={14} /> : undefined}>
                      {s.allowed ? "Allowed" : "Allow"}
                    </Button>
                  </div>
                </Card>
                <div className="bx-set__rows">
                  <Bar w={96} h={5} tone={3} />
                  {[150, 118, 136].map((w, i) => (
                    <div key={i} className="bx-set__row">
                      <span className="bx-ask__glyph bx-ask__glyph--dim" />
                      <Bar w={w} h={5} tone={2} />
                    </div>
                  ))}
                </div>
              </div>
            </Window>
            <div className="bx-phone">
              <Phone width={compact ? 260 : 380} frame="pro" dark>
                <RemoteScreen live={s.allowed} />
              </Phone>
            </div>
          </>
        );
      }}
    </Stage>
  );
}

// ---------------------------------------------------------------- Menu bar

async function menuScript(a: Act<{ open: boolean }>) {
  await a.wait(700);
  await a.move({ at: "tray" });
  await a.wait(200);
  await a.click();
  a.set({ open: true });
  await a.wait(700);
  await a.move({ at: "pop", x: 0.15, y: 1.08 });
}

export function MenuBarTile() {
  return (
    <Stage
      width={380}
      height={300}
      initial={{ open: false }}
      poster={{ open: true }}
      script={menuScript}
      play="once"
      theme="dark"
      cursor={{ at: { at: "tray", x: -1.2, y: 3 } }}
      className="bx bx--menu"
    >
      {(s) => (
        <>
          <div className="bx-menubar">
            <Bar w={30} h={6} tone={3} />
            <Bar w={22} h={6} tone={2} />
            <Bar w={26} h={6} tone={2} />
            <span className="bx-menubar__spacer" />
            <span className="bx-tray" data-target="tray" data-open={s.open || undefined}>
              <img src={trayIcon} alt="" />
            </span>
            <Wifi size={14} />
            <BatteryFull size={16} />
            <span className="bx-menubar__time">9:41</span>
          </div>
          <Popover show={s.open} origin="top" className="bx-pop" data-target="pop">
            <div className="bx-pop__song">
              <span className="bx-pop__art" />
              <span className="bx-pop__text">
                <span className="bx-pop__title">Saffron Skies</span>
                <span className="bx-pop__artist">The Lowlands</span>
              </span>
            </div>
            <div className="bx-pop__scrub">
              <span />
            </div>
            <div className="bx-pop__controls">
              <SkipBack size={16} fill="currentColor" strokeWidth={0} />
              <span className="bx-pop__play">
                <Pause size={14} fill="currentColor" strokeWidth={0} />
              </span>
              <SkipForward size={16} fill="currentColor" strokeWidth={0} />
            </div>
            <div className="bx-pop__next">
              <Bar w={38} h={4} tone={2} />
              <div className="bx-pop__row">
                <span className="bx-pop__thumb" />
                <Bar w={96} h={5} tone={3} />
              </div>
            </div>
          </Popover>
        </>
      )}
    </Stage>
  );
}

// ---------------------------------------------------------------- Import

const SOURCES: Array<{ icon: SimpleIcon; label: string }> = [
  { icon: siSpotify, label: "Spotify" },
  { icon: siApplemusic, label: "Apple Music" },
  { icon: siDeezer, label: "Deezer" },
  { icon: siYoutubemusic, label: "YouTube Music" },
];

type ImportS = { line: boolean; matched: number };

async function importScript(a: Act<ImportS>) {
  await a.wait(500);
  a.set({ line: true });
  await a.wait(900);
  a.set({ matched: 48 });
}

export function ImportTile() {
  return (
    <Stage
      width={380}
      height={300}
      initial={{ line: false, matched: 0 }}
      poster={{ line: true, matched: 48 }}
      script={importScript}
      play="once"
      theme="dark"
      accent="#d71921"
      className="bx bx--import"
    >
      {(s, rect) => {
        const from = rect("src-0");
        const to = rect("playlist");
        return (
          <>
            <div className="bx-sources">
              {SOURCES.map((src, i) => (
                <span key={src.label} className="bx-source" data-on={i === 0 || undefined} data-target={`src-${i}`} title={src.label}>
                  <svg viewBox="0 0 24 24" width={26} height={26} aria-label={src.label} role="img">
                    <path d={src.icon.path} fill={`#${src.icon.hex}`} />
                  </svg>
                </span>
              ))}
            </div>
            {from && to && (
              <Connector
                show={s.line}
                route="step"
                from={{ x: from.x + from.width / 2, y: from.y + from.height }}
                to={{ x: to.x + 40, y: to.y }}
                className="bx-line"
              />
            )}
            <Card pad="large" lift className="bx-playlist" data-target="playlist">
              <div className="bx-playlist__head">
                <span className="bx-playlist__art" />
                <span className="bx-playlist__text">
                  <span className="bx-playlist__name">Road trip</span>
                  <span className="bx-playlist__count">
                    <Count value={s.matched} duration={1400} /> of 48 songs matched
                  </span>
                </span>
              </div>
              <Meter value={s.matched / 48} className="bx-meter" />
            </Card>
          </>
        );
      }}
    </Stage>
  );
}

// ---------------------------------------------------------------- Keys

type KeysS = { pressed: number; playing: boolean };

async function keysScript(a: Act<KeysS>) {
  await a.wait(800);
  a.set({ pressed: 1 });
  await a.wait(160);
  a.set({ pressed: -1, playing: false });
  await a.wait(1300);
  a.set({ pressed: 1 });
  await a.wait(160);
  a.set({ pressed: -1, playing: true });
}

export function KeysTile() {
  const keys = [<SkipBack key="b" size={20} fill="currentColor" strokeWidth={0} />, null, <SkipForward key="f" size={20} fill="currentColor" strokeWidth={0} />];
  return (
    <Stage width={380} height={300} initial={{ pressed: -1, playing: true }} poster={{ pressed: -1, playing: true }} script={keysScript} play="once" theme="dark" className="bx bx--keys">
      {(s) => (
        <div className="bx-keys">
          {keys.map((glyph, i) => (
            <span key={i} className="bx-key" data-pressed={s.pressed === i || undefined} data-main={i === 1 || undefined}>
              <span className="bx-key__f">F{7 + i}</span>
              {glyph ?? (
                <span className="bx-key__pp">
                  <Play size={16} fill="currentColor" strokeWidth={0} />
                  <Pause size={16} fill="currentColor" strokeWidth={0} />
                </span>
              )}
            </span>
          ))}
          <div className="bx-keys__state" data-playing={s.playing || undefined}>
            <span className="bx-keys__icon">
              <Pause size={14} fill="currentColor" strokeWidth={0} className="bx-keys__pause" />
              <Play size={14} fill="currentColor" strokeWidth={0} className="bx-keys__play" />
            </span>
            <span className="bx-keys__label">
              <span className="bx-keys__on">Playing</span>
              <span className="bx-keys__off">Paused</span>
            </span>
          </div>
        </div>
      )}
    </Stage>
  );
}

// ---------------------------------------------------------------- Stat

function Counter({ to, suffix }: { to: number; suffix: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  const [value, setValue] = useState(reduce ? to : 0);
  useEffect(() => {
    if (!inView || reduce) return;
    const c = animate(0, to, { duration: 1.2, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => setValue(Math.round(v)) });
    return () => c.stop();
  }, [inView, reduce, to]);
  return (
    <span ref={ref} className="bento-stat__num">
      {value}
      <span className="bento-stat__unit">{suffix}</span>
    </span>
  );
}

// ---------------------------------------------------------------- Grid

function Tile({ className = "", lead, title, children }: { className?: string; lead: string; title: string; children?: ReactNode }) {
  return (
    <article className={`bento-tile ${className}`}>
      <p className="bento-copy">
        <b>{lead}</b> {title}
      </p>
      {children && <div className="bento-pic">{children}</div>}
    </article>
  );
}

export function FeatureBento() {
  return (
    <div className="bento">
      <Tile className="bento-tile--wide" lead="Your phone is the remote." title="Scan a code, allow it once, and play, skip, search and read lyrics from anywhere. Any network, end-to-end encrypted.">
        <RemoteTile />
      </Tile>
      <article className="bento-tile bento-stat">
        <p className="bento-stat__lead">The whole app is</p>
        <Counter to={17} suffix="MB" />
        <p className="bento-stat__label">Built with Tauri and Rust, not a bundled browser. A 6 MB download.</p>
      </article>
      <Tile lead="One click away." title="A mini player in the menu bar, over full-screen apps too.">
        <MenuBarTile />
      </Tile>
      <Tile lead="Bring your playlists." title="From Spotify, Apple Music, Deezer or YouTube.">
        <ImportTile />
      </Tile>
      <Tile lead="Feels native." title="Media keys, AirPods, Control Center and the lock screen.">
        <KeysTile />
      </Tile>
    </div>
  );
}
