import { createContext, useContext, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Laptop, MonitorSpeaker, Tv } from "lucide-react";
import { getTvs, type TvStatus } from "../../lib/tvs";
import { isTauriEnvironment } from "../../lib/search";

/** Where playback comes out, shared from App so the picker needs no props threaded to it. */
export const OutputContext = createContext<{
  /** The TV playing, by id; null is this computer. */
  output: string | null;
  selectOutput: (id: string | null) => void;
} | null>(null);

/** "Play on": this computer or a linked TV. Hidden until a TV has been linked. */
export function OutputPicker() {
  const context = useContext(OutputContext);
  const [status, setStatus] = useState<TvStatus | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const refresh = () => void getTvs().then(setStatus, () => {});
    refresh();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("tvs-changed", refresh).then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!context || !status || status.linked.length === 0) return null;
  const { output, selectOutput } = context;
  const playingOn = status.linked.find((tv) => tv.id === output);
  const choose = (id: string | null) => {
    selectOutput(id);
    setOpen(false);
  };

  return (
    <div className="np-output" ref={rootRef}>
      <button
        type="button"
        className={`np-pill np-round-btn ${playingOn ? "is-on" : ""}`}
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={playingOn ? `Playing on ${playingOn.name}` : "Play on a TV"}
        title={playingOn ? `Playing on ${playingOn.name}` : "Play on a TV"}
      >
        <MonitorSpeaker size={19} />
        {playingOn && <span className="np-output-on">{playingOn.name}</span>}
      </button>
      {open && (
        <div className="np-output-menu" role="menu" aria-label="Play on">
          <span className="np-output-title">Play on</span>
          <button type="button" role="menuitemradio" aria-checked={!output} className="np-output-item" onClick={() => choose(null)}>
            <Laptop size={17} />
            <span className="np-output-name">This computer</span>
            {!output && <Check size={16} />}
          </button>
          {status.linked.map((tv) => (
            <button
              key={tv.id}
              type="button"
              role="menuitemradio"
              aria-checked={output === tv.id}
              className="np-output-item"
              disabled={!tv.online}
              onClick={() => choose(tv.id)}
            >
              <Tv size={17} />
              <span className="np-output-name">
                {tv.name}
                {!tv.online && <small>Off or out of reach</small>}
              </span>
              {output === tv.id && <Check size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
