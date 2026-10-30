import { motion, useReducedMotion } from "motion/react";
import { Download } from "lucide-react";
import { VISITOR_PLATFORM, downloadFor, type RepoInfo } from "../lib/github";
import { StarButton } from "./Nav";
import { HeroShot } from "./Showcase";

const HEADLINE = ["Your music.", "Every mood."];

function TypedHeadline() {
  const reduce = useReducedMotion();
  let i = 0;
  return (
    <h1 className="hero-title" aria-label={HEADLINE.join(" ")}>
      {HEADLINE.map((line) => (
        <span key={line} className="hero-line" aria-hidden="true">
          {Array.from(line).map((ch) => {
            const delay = 0.25 + i++ * 0.045;
            return (
              <motion.span
                key={`${line}-${i}`}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay, duration: 0.18 }}
                className={ch === "." ? "hero-dot" : undefined}
              >
                {ch === "." ? "." : ch}
              </motion.span>
            );
          })}
        </span>
      ))}
    </h1>
  );
}

export function Hero({ info }: { info: RepoInfo }) {
  // The visitor's own platform goes first; the other one is a plain link under it.
  const main = downloadFor(info, VISITOR_PLATFORM);
  const other = downloadFor(info, VISITOR_PLATFORM === "windows" ? "mac" : "windows");
  return (
    <section className="hero" id="top">
      <div className="dotgrid" aria-hidden="true" />
      <div className="hero-copy">
        <p className="kicker">
          <span className="red-dot" /> A YouTube Music player for Mac and Windows
        </p>
        <TypedHeadline />
        <p className="hero-sub">
          Lyrics that move with the voice, three players in one, a record that really spins, and your music one click away in
          the menu bar. Free and open source.
        </p>
        <div className="hero-ctas">
          <a className="btn btn-red btn-lg" href={main.url}>
            <Download size={18} />
            {main.label}
          </a>
          <StarButton stars={info.stars} className="btn-lg" />
        </div>
        <p className="hero-meta">
          {main.version ?? "Latest release"} · {main.meta}
        </p>
        <p className="hero-alt">
          Also available: <a href={other.url}>{other.label.replace("Download for ", "")}</a>
          {other.version ? ` (${other.version})` : ""}
        </p>
      </div>

      <HeroShot />
    </section>
  );
}
