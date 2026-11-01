import { useEffect, useMemo, useState } from "react";
import {
  defaultView,
  listDisplays,
  loadDisplayChoices,
  saveDisplayChoice,
  type DisplayChoice,
  type ImmersiveDisplay,
} from "../../lib/immersive";

const CHOICES: Array<{ id: DisplayChoice; label: string }> = [
  { id: "stage", label: "Clock" },
  { id: "lyrics", label: "Lyrics" },
  { id: "art", label: "Artwork" },
  { id: "off", label: "Off" },
];

const LABEL: Record<DisplayChoice, string> = { stage: "Clock", lyrics: "Lyrics", art: "Artwork", off: "Off" };

/** The map's drawing area; it's drawn as percentages, so it fits any modal width. */
const MAP_W = 420;
const MAP_H = 150;
const GAP = 6;
const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/**
 * Settings' display picker: the displays drawn as they're arranged (like macOS Displays
 * settings). Click one, then pick what it shows, or turn it off.
 */
export function ImmersiveDisplays() {
  const [displays, setDisplays] = useState<ImmersiveDisplay[] | null>(null);
  const [choices, setChoices] = useState(loadDisplayChoices);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void listDisplays().then((list) => !cancelled && setDisplays(list));
    return () => {
      cancelled = true;
    };
  }, []);

  const layout = useMemo(() => {
    if (!displays?.length) return [];
    const minX = Math.min(...displays.map((d) => d.x));
    const minY = Math.min(...displays.map((d) => d.y));
    const maxX = Math.max(...displays.map((d) => d.x + d.width));
    const maxY = Math.max(...displays.map((d) => d.y + d.height));
    const scale = Math.min(MAP_W / (maxX - minX), MAP_H / (maxY - minY));
    const offsetX = (MAP_W - (maxX - minX) * scale) / 2;
    const offsetY = (MAP_H - (maxY - minY) * scale) / 2;
    return displays.map((d) => {
      const height = d.height * scale - GAP;
      return {
        style: {
          left: pct(offsetX + (d.x - minX) * scale + GAP / 2, MAP_W),
          top: pct(offsetY + (d.y - minY) * scale + GAP / 2, MAP_H),
          width: pct(d.width * scale - GAP, MAP_W),
          height: pct(height, MAP_H),
        },
        roomy: height > 64,
      };
    });
  }, [displays]);

  if (!displays?.length) return null;

  const choiceOf = (index: number): DisplayChoice => choices[displays[index].key] ?? defaultView(index);
  const onCount = displays.filter((_, i) => choiceOf(i) !== "off").length;
  const current = displays[Math.min(selected, displays.length - 1)];
  const currentIndex = displays.indexOf(current);
  const currentChoice = choiceOf(currentIndex);

  const choose = (choice: DisplayChoice) => {
    saveDisplayChoice(current.key, choice);
    setChoices((prev) => ({ ...prev, [current.key]: choice }));
  };

  return (
    <div className="im-displays">
      <div className="im-displays-map" style={{ aspectRatio: `${MAP_W} / ${MAP_H}` }} role="listbox" aria-label="Displays">
        {displays.map((d, i) => {
          const choice = choiceOf(i);
          return (
            <button
              key={d.key}
              type="button"
              role="option"
              aria-selected={i === currentIndex}
              className={`im-display${i === currentIndex ? " is-selected" : ""}${choice === "off" ? " is-off" : ""}`}
              style={layout[i].style}
              title={`${d.name} · ${d.pixelWidth}×${d.pixelHeight}`}
              onClick={() => setSelected(i)}
            >
              {d.isAppDisplay && <span className="im-display-dot" aria-label="dot(.)music is on this display" />}
              <span className="im-display-view">{LABEL[choice]}</span>
              {layout[i].roomy && <span className="im-display-name">{d.name}</span>}
            </button>
          );
        })}
      </div>

      <div className="im-displays-detail">
        <div className="settings-row-text">
          <span className="settings-label">{current.name}</span>
          <span className="settings-desc">
            {current.pixelWidth} × {current.pixelHeight}
            {current.height > current.width ? " · Portrait" : current.width / current.height >= 2 ? " · Ultrawide" : ""}
            {current.isAppDisplay ? " · dot(.)music is here" : ""}
          </span>
        </div>
        <div className="settings-segmented" role="radiogroup" aria-label={`${current.name} shows`}>
          {CHOICES.map(({ id, label }) => {
            // At least one display always shows immersive mode.
            const disabled = id === "off" && currentChoice !== "off" && onCount <= 1;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={currentChoice === id}
                className={currentChoice === id ? "is-on" : undefined}
                disabled={disabled}
                title={disabled ? "At least one display shows immersive mode" : undefined}
                onClick={() => choose(id)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
