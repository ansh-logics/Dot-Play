import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { Check, Copy, Download, FolderInput, ShieldCheck } from "lucide-react";
import { ISSUES_URL, RELEASES_URL, REPO_URL, VISITOR_PLATFORM, downloadFor, type Platform, type RepoInfo } from "../lib/github";
import { Logo, StarButton } from "./Nav";

function Counter({ to, decimals = 0, suffix = "" }: { to: number; decimals?: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  const [value, setValue] = useState(reduce ? to : 0);
  useEffect(() => {
    if (!inView || reduce) return;
    const controls = animate(0, to, { duration: 1.4, ease: [0.22, 1, 0.36, 1], onUpdate: setValue });
    return () => controls.stop();
  }, [inView, reduce, to]);
  return (
    <span ref={ref}>
      {value.toFixed(decimals)}
      {suffix}
    </span>
  );
}

const STATS = [
  { value: <Counter to={17} suffix=" MB" />, label: "The whole app. Built with Tauri and Rust, not a bundled browser." },
  { value: <Counter to={6} suffix=" MB" />, label: "The download." },
  { value: <Counter to={0} suffix=" MB" />, label: "Memory the menu bar player uses while it's closed." },
  { value: <span>⏯</span>, label: "Media keys, AirPods, Control Center and the lock screen, natively." },
];

export function BuiltLight() {
  return (
    <section className="section built" aria-labelledby="built-title">
      <p className="kicker">
        <span className="red-dot" /> Built light
      </p>
      <h2 id="built-title" className="section-title">
        Small, fast, and very much a Mac app.
      </h2>
      <div className="stats">
        {STATS.map((s, i) => (
          <motion.div
            key={i}
            className="stat"
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ delay: i * 0.08, duration: 0.6 }}
          >
            <div className="stat-value">{s.value}</div>
            <p className="stat-label">{s.label}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

const XATTR = "xattr -dr com.apple.quarantine /Applications/dot-music.app";

function CopyCommand() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code>{XATTR}</code>
      <button
        type="button"
        className="command-copy"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard.writeText(XATTR).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

function macSteps(info: RepoInfo) {
  return [
    {
      icon: <Download size={22} />,
      title: "Download",
      body: (
        <>
          Get the <a href={info.dmgUrl ?? RELEASES_URL}>.dmg from the latest release</a>
          {info.version ? ` (${info.version})` : ""}.
        </>
      ),
    },
    { icon: <FolderInput size={22} />, title: "Drag to Applications", body: <>Open the .dmg and drag dot-music into Applications.</> },
    {
      icon: <ShieldCheck size={22} />,
      title: "Allow it once",
      body: (
        <>
          The first launch is blocked because the app isn't signed with an Apple Developer ID yet. Open it once, then go to{" "}
          <b>System Settings → Privacy &amp; Security</b> and click <b>Open Anyway</b>. Or run:
        </>
      ),
      extra: <CopyCommand />,
    },
  ];
}

function windowsSteps(info: RepoInfo) {
  const win = downloadFor(info, "windows");
  return [
    {
      icon: <Download size={22} />,
      title: "Download",
      body: (
        <>
          Get the <a href={win.url}>Windows installer (.exe)</a>
          {win.version ? ` (${win.version})` : ""}. Windows 10 or 11, 64-bit.
        </>
      ),
    },
    {
      icon: <FolderInput size={22} />,
      title: "Run the installer",
      body: <>Open the downloaded file. It installs dot-music for you and adds it to the Start menu. Updates install themselves after that.</>,
    },
    {
      icon: <ShieldCheck size={22} />,
      title: "Allow it once",
      body: (
        <>
          The installer isn't code-signed yet, so Windows SmartScreen may stop it. Click <b>More info</b>, then <b>Run anyway</b>.
        </>
      ),
    },
  ];
}

const PLATFORM_LABEL: Record<Platform, string> = { mac: "Mac", windows: "Windows" };

export function Install({ info }: { info: RepoInfo }) {
  const [platform, setPlatform] = useState<Platform>(VISITOR_PLATFORM);
  const steps: Array<{ icon: ReactNode; title: string; body: ReactNode; extra?: ReactNode }> =
    platform === "windows" ? windowsSteps(info) : macSteps(info);
  return (
    <section className="section" id="install" aria-labelledby="install-title">
      <p className="kicker">
        <span className="red-dot" /> Install
      </p>
      <h2 id="install-title" className="section-title">
        Up and running in a minute.
      </h2>
      <div className="platform-switch" role="tablist" aria-label="Your computer">
        {(["mac", "windows"] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={platform === p}
            className={platform === p ? "is-on" : undefined}
            onClick={() => setPlatform(p)}
          >
            {PLATFORM_LABEL[p]}
          </button>
        ))}
      </div>
      <ol className="steps" key={platform}>
        {steps.map((s, i) => (
          <motion.li
            key={s.title}
            className="step"
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ delay: i * 0.1, duration: 0.6 }}
          >
            <div className="step-head">
              <span className="step-icon">{s.icon}</span>
              <span className="step-num">{i + 1}</span>
            </div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
            {s.extra}
          </motion.li>
        ))}
      </ol>
    </section>
  );
}

const FAQ = [
  { q: "Is it free?", a: "Yes. dot(.)music is free and open source. The code is on GitHub." },
  { q: "Do I need a YouTube Music account?", a: "You sign in with your own YouTube Music account inside the app, so your library, playlists and history come with you." },
  {
    q: "Why does macOS warn me when I open it?",
    a: "The app is signed, but not yet with a paid Apple Developer ID, so macOS can't verify the developer. Allow it once in Privacy & Security (see Install). A notarized build is planned.",
  },
  {
    q: "Which computers does it run on?",
    a: "Macs with Apple silicon (M1 and later) on macOS 13 Ventura or newer, and 64-bit Windows 10 or 11 PCs. Intel Mac builds may come later.",
  },
  {
    q: "Why does Windows warn me when I install it?",
    a: "The installer isn't code-signed yet, so SmartScreen doesn't recognise it. Click More info, then Run anyway. You only need to do this once; updates install themselves.",
  },
  { q: "Found a bug or have an idea?", a: "Open an issue on GitHub. Feedback is very welcome." },
];

export function Faq() {
  return (
    <section className="section" id="faq" aria-labelledby="faq-title">
      <p className="kicker">
        <span className="red-dot" /> FAQ
      </p>
      <h2 id="faq-title" className="section-title">
        Questions, answered.
      </h2>
      <div className="faq">
        {FAQ.map((item) => (
          <details key={item.q} className="faq-item">
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function FinalCta({ info }: { info: RepoInfo }) {
  return (
    <section className="final">
      <div className="dotgrid" aria-hidden="true" />
      <h2 className="final-title">
        Put your music <span className="red">on</span>.
      </h2>
      <div className="hero-ctas">
        <a className="btn btn-red btn-lg" href={downloadFor(info, VISITOR_PLATFORM).url}>
          <Download size={18} />
          {downloadFor(info, VISITOR_PLATFORM).label}
        </a>
        <StarButton stars={info.stars} className="btn-lg" />
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <Logo />
      <nav className="footer-links" aria-label="Project">
        <a href={REPO_URL}>GitHub</a>
        <a href={RELEASES_URL}>Releases</a>
        <a href={ISSUES_URL}>Report an issue</a>
      </nav>
      <p className="footer-note">
        Built by Ansh Bhatt · Not affiliated with YouTube or Google · Songs and covers on this page are made up.
      </p>
    </footer>
  );
}
