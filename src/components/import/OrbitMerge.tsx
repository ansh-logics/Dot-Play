import { useEffect, useRef } from "react";

export interface OrbitSong {
  title: string;
  artist: string;
  /** The source's cover for the song, if it has one. */
  cover?: string;
}

/** undefined: still searching; null: not found; a string: found (its thumbnail, if any). */
export type OrbitResult = string | null | undefined;

interface OrbitMergeProps {
  songs: OrbitSong[];
  results: OrbitResult[];
  /** Runs once every song has merged or faded away. */
  onSettled: () => void;
  onMerged?: () => void;
}

/** Songs on show at once; the rest wait their turn to spawn. */
const MAX_VISIBLE = 36;
const SPAWN_EVERY_MS = 80;
const SPAWN_MS = 520;
/** Every song circles at least this long before it can merge, so each one is seen. */
const MIN_ORBIT_MS = 900;
const MERGE_MS = 950;
const REJECT_MS = 1100;

/** Three tilted elliptical rings: size relative to the stage, tilt, and angular speed. */
const RINGS = [
  { r: 0.27, squash: 0.46, tilt: -0.2, speed: 0.55 },
  { r: 0.37, squash: 0.42, tilt: 0.14, speed: -0.38 },
  { r: 0.47, squash: 0.38, tilt: -0.06, speed: 0.26 },
];

type Phase = "spawn" | "orbit" | "merge" | "reject";

interface Orbiter {
  index: number;
  el: HTMLDivElement;
  ring: (typeof RINGS)[number];
  angle0: number;
  born: number;
  phase: Phase;
  phaseAt: number;
  /** Where it was when it left its ring. */
  from?: { x: number; y: number; scale: number };
}

const easeOutBack = (t: number) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
const easeInCubic = (t: number) => t * t * t;

function initials(song: OrbitSong): string {
  const words = song.title.replace(/[^\p{L}\p{N} ]/gu, "").split(" ").filter(Boolean);
  return (words[0]?.[0] ?? "♪") + (words[1]?.[0] ?? "");
}

/** A warm hue per song so the initials discs aren't all the same. */
function hue(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 31 + c.codePointAt(0)!) % 360;
  return h;
}

function makeOrbiterEl(song: OrbitSong, thumb: string | undefined): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "orbit-song";
  const src = song.cover || thumb;
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.draggable = false;
    el.appendChild(img);
  } else {
    el.classList.add("is-initials");
    el.style.setProperty("--orbit-hue", String(hue(song.title + song.artist)));
    el.textContent = initials(song);
  }
  return el;
}

/**
 * Songs spawn onto rings around the dot(.)music mark. Each found song leaves its ring and
 * spirals into the dot, which pulses as it lands; a song that wasn't found drifts outward
 * and fades. Positions are written straight to the DOM from one animation frame loop,
 * so React only renders the stage once.
 */
export function OrbitMerge({ songs, results, onSettled, onMerged }: OrbitMergeProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef(results);
  const callbacksRef = useRef({ onSettled, onMerged });
  useEffect(() => {
    resultsRef.current = results;
    callbacksRef.current = { onSettled, onMerged };
  });

  useEffect(() => {
    const stage = stageRef.current;
    const core = coreRef.current;
    if (!stage || !core) return;

    const live: Orbiter[] = [];
    let nextIndex = 0;
    let lastSpawn = -Infinity;
    let settled = false;
    let frame = 0;

    const pulse = () => {
      core.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.14)" }, { transform: "scale(1)" }],
        { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
      const ripple = document.createElement("span");
      ripple.className = "orbit-ripple";
      stage.appendChild(ripple);
      ripple
        .animate(
          [
            { transform: "translate(-50%, -50%) scale(0.5)", opacity: 0.55 },
            { transform: "translate(-50%, -50%) scale(2.6)", opacity: 0 },
          ],
          { duration: 900, easing: "cubic-bezier(.1,.7,.3,1)" },
        )
        .finished.then(() => ripple.remove(), () => ripple.remove());
    };

    const tick = (now: number) => {
      const size = stage.clientWidth;
      const cx = size / 2;
      const cy = stage.clientHeight / 2;
      const songSize = Math.max(26, Math.min(44, size * 0.075));

      // Spawn the next waiting song.
      if (nextIndex < songs.length && live.length < MAX_VISIBLE && now - lastSpawn >= SPAWN_EVERY_MS) {
        const index = nextIndex++;
        const result = resultsRef.current[index];
        const el = makeOrbiterEl(songs[index], typeof result === "string" ? result : undefined);
        el.style.width = el.style.height = `${songSize}px`;
        stage.appendChild(el);
        live.push({
          index,
          el,
          ring: RINGS[index % RINGS.length],
          angle0: Math.random() * Math.PI * 2,
          born: now,
          phase: "spawn",
          phaseAt: now,
        });
        lastSpawn = now;
      }

      for (let i = live.length - 1; i >= 0; i--) {
        const o = live[i];
        const t = (now - o.born) / 1000;
        const angle = o.angle0 + o.ring.speed * t;
        const rx = o.ring.r * size;
        const ry = rx * o.ring.squash;
        const ex = Math.cos(angle) * rx;
        const ey = Math.sin(angle) * ry;
        const cos = Math.cos(o.ring.tilt);
        const sin = Math.sin(o.ring.tilt);
        const ox = ex * cos - ey * sin;
        const oy = ex * sin + ey * cos;
        // Front of the ring (bottom) is larger and passes in front of the dot.
        const depth = Math.sin(angle);
        const orbitScale = 0.78 + 0.22 * ((depth + 1) / 2);

        let x = cx + ox;
        let y = cy + oy;
        let scale = orbitScale;
        let opacity = 1;
        let front = depth > 0;

        if (o.phase === "spawn") {
          const u = Math.min(1, (now - o.phaseAt) / SPAWN_MS);
          scale *= Math.max(0, easeOutBack(u));
          opacity = Math.min(1, u * 2);
          if (u >= 1) {
            o.phase = "orbit";
            o.phaseAt = now;
          }
        }

        if (o.phase === "orbit" && now - o.born >= MIN_ORBIT_MS) {
          const result = resultsRef.current[o.index];
          if (result !== undefined) {
            o.phase = result === null ? "reject" : "merge";
            o.phaseAt = now;
            o.from = { x: ox, y: oy, scale: orbitScale };
            o.el.classList.add(result === null ? "is-missing" : "is-merging");
            // A song without its own cover shows the matched one as it merges.
            if (typeof result === "string" && result && o.el.classList.contains("is-initials")) {
              o.el.classList.remove("is-initials");
              o.el.textContent = "";
              const img = document.createElement("img");
              img.src = result;
              img.alt = "";
              img.referrerPolicy = "no-referrer";
              o.el.appendChild(img);
            }
          }
        }

        if (o.phase === "merge" && o.from) {
          const u = Math.min(1, (now - o.phaseAt) / MERGE_MS);
          const e = easeInCubic(u);
          // Spiral: the remaining radius shrinks while the angle keeps turning faster.
          const turn = e * 2.4;
          const shrink = (1 - e) ** 1.3;
          const fx = o.from.x * Math.cos(turn) - o.from.y * Math.sin(turn);
          const fy = o.from.x * Math.sin(turn) + o.from.y * Math.cos(turn);
          x = cx + fx * shrink;
          y = cy + fy * shrink;
          scale = o.from.scale * (1 - 0.85 * e);
          opacity = 1 - Math.max(0, (u - 0.8) / 0.2);
          front = true;
          if (u >= 1) {
            o.el.remove();
            live.splice(i, 1);
            pulse();
            callbacksRef.current.onMerged?.();
            continue;
          }
        } else if (o.phase === "reject" && o.from) {
          const u = Math.min(1, (now - o.phaseAt) / REJECT_MS);
          const grow = 1 + 0.45 * u;
          x = cx + o.from.x * grow;
          y = cy + o.from.y * grow + 18 * u;
          scale = o.from.scale * (1 - 0.3 * u);
          opacity = 1 - u;
          if (u >= 1) {
            o.el.remove();
            live.splice(i, 1);
            continue;
          }
        }

        o.el.style.transform = `translate(${x - songSize / 2}px, ${y - songSize / 2}px) scale(${scale})`;
        o.el.style.opacity = String(opacity);
        o.el.style.zIndex = front ? "3" : "1";
      }

      if (nextIndex >= songs.length && live.length === 0) {
        if (!settled) {
          settled = true;
          callbacksRef.current.onSettled();
        }
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const o of live) o.el.remove();
      stage.querySelectorAll(".orbit-ripple").forEach((r) => r.remove());
    };
  }, [songs]);

  const total = songs.length;
  const done = results.filter((r) => r !== undefined).length;

  return (
    <div ref={stageRef} className="orbit-stage" role="img" aria-label={`Matching songs: ${done} of ${total}`}>
      <svg className="orbit-rings" viewBox="-50 -50 100 100" aria-hidden="true">
        {RINGS.map((ring, i) => (
          <ellipse
            key={i}
            rx={ring.r * 100}
            ry={ring.r * 100 * ring.squash}
            transform={`rotate(${(ring.tilt * 180) / Math.PI})`}
          />
        ))}
      </svg>
      <div className="orbit-core-wrap">
        <div ref={coreRef} className="orbit-core">
          <span className="orbit-core-dot" />
        </div>
        <span className="orbit-wordmark">dot(.)music</span>
      </div>
    </div>
  );
}
