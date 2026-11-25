import { memo, type CSSProperties } from "react";
import { Power, Radio as RadioIcon } from "lucide-react";
import { StationBadge } from "../components/radio/StationBadge";
import { RADIO_ERAS, findStation, stationTitle, stationsForEra, type RadioStation } from "../lib/radioStations";
import type { SearchResult } from "../lib/search";
import type { RadioController } from "../lib/useRadio";

interface RadioViewProps {
  radio: RadioController;
  currentTrack: SearchResult | null;
  onOpenWheel: () => void;
}

function Equalizer() {
  return (
    <span className="radio-eq" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

const StationCard = memo(function StationCard({
  station,
  playing,
  tuning,
  onTune,
}: {
  station: RadioStation;
  playing: boolean;
  tuning: boolean;
  onTune: (id: string) => void;
}) {
  const count = station.songs.length;
  return (
    <button
      type="button"
      className={`radio-card${playing ? " is-playing" : ""}${tuning ? " is-tuning" : ""}`}
      style={{ "--radio-accent": station.colors[0] } as CSSProperties}
      aria-pressed={playing}
      aria-label={`${stationTitle(station)}, ${station.genre}${playing ? ", on air" : tuning ? ", tuning" : ""}`}
      onClick={() => {
        if (!playing && !tuning) onTune(station.id);
      }}
    >
      <span className="radio-card-badge">
        <StationBadge station={station} size={64} active={playing} />
      </span>
      <span className="radio-card-body">
        <span className="radio-card-title-row">
          <span className="radio-card-title">{stationTitle(station)}</span>
          {playing && (
            <span className="radio-card-onair">
              <Equalizer />
              On air
            </span>
          )}
          {tuning && (
            <span className="radio-card-onair is-tuning">
              <span className="loading-spinner radio-card-spinner" />
              Tuning
            </span>
          )}
        </span>
        <span className="radio-card-genre">{station.genre}</span>
        <span className="radio-card-vibe">{station.vibe}</span>
        <span className="radio-card-foot">
          <span className="radio-card-host">Hosted by {station.host}</span>
          <span className="radio-card-count">
            {count} {count === 1 ? "song" : "songs"}
          </span>
        </span>
        {station.confirmed === false && <span className="radio-card-tag">Unconfirmed lineup</span>}
      </span>
    </button>
  );
});

/** The Radio page: what's on air, then every station grouped by era. */
export const RadioView = memo(function RadioView({ radio, currentTrack, onOpenWheel }: RadioViewProps) {
  const { station, status } = radio;
  const live = status !== "off" && station ? station : undefined;
  const tune = (id: string) => void radio.tune(id);
  const resumeId = findStation(radio.lastStationId)?.id ?? stationsForEra("vi")[0]?.id;
  const resume = resumeId ? findStation(resumeId) : undefined;

  return (
    <div className="radio-view">
      <header className="radio-header">
        <h1 className="radio-title">Radio</h1>
        <p className="radio-subtitle">Hand-picked stations from Leonida, Los Santos and Vice City. Real songs, always on air.</p>
      </header>

      {live ? (
        <section
          className={`radio-hero${status === "tuning" ? " is-tuning" : ""}`}
          style={{ "--radio-accent": live.colors[0] } as CSSProperties}
          aria-label="Now on air"
        >
          <StationBadge station={live} size={112} active className="radio-hero-badge" />
          <div className="radio-hero-body">
            <span className="radio-hero-kicker">
              {status === "tuning" ? (
                <>
                  <span className="loading-spinner radio-card-spinner" /> Tuning…
                </>
              ) : (
                <>
                  <Equalizer /> Now on air
                </>
              )}
            </span>
            <h2 className="radio-hero-title">{stationTitle(live)}</h2>
            <p className="radio-hero-host">
              {live.genre} · Hosted by {live.host}
            </p>
            <p className="radio-hero-vibe">{live.vibe}</p>
            {status === "on" && currentTrack && (
              <p className="radio-hero-song">
                <span className="radio-hero-song-title">{currentTrack.title}</span>
                <span className="radio-hero-song-artist">{currentTrack.artist}</span>
              </p>
            )}
          </div>
          <div className="radio-hero-actions">
            <button type="button" className="radio-btn radio-btn-ghost" onClick={onOpenWheel}>
              <RadioIcon size={16} /> Wheel
            </button>
            <button type="button" className="radio-btn" onClick={() => radio.off()}>
              <Power size={16} /> Off
            </button>
          </div>
        </section>
      ) : (
        <section className="radio-hero radio-hero-idle" aria-label="Tune in">
          <div className="radio-hero-body">
            <span className="radio-hero-kicker">Radio off</span>
            <h2 className="radio-hero-title">Tune in</h2>
            <p className="radio-hero-vibe">
              {resume ? `Pick up where you left off on ${stationTitle(resume)}, or choose a station below.` : "Choose a station below."}
            </p>
            <p className="radio-hero-hint">
              Hold <kbd className="radio-kbd">R</kbd> anywhere for the radio wheel
            </p>
          </div>
          <div className="radio-hero-actions">
            {resume && (
              <button type="button" className="radio-btn radio-btn-primary" onClick={() => tune(resume.id)}>
                <RadioIcon size={16} /> Tune in
              </button>
            )}
            <button type="button" className="radio-btn radio-btn-ghost" onClick={onOpenWheel}>
              Open the wheel
            </button>
          </div>
        </section>
      )}

      {RADIO_ERAS.map((era) => {
        const list = stationsForEra(era.id);
        if (list.length === 0) return null;
        return (
          <section key={era.id} className="radio-era" aria-labelledby={`radio-era-${era.id}`}>
            <div className="radio-era-head">
              <h2 id={`radio-era-${era.id}`} className="radio-era-title">
                {era.label}
              </h2>
              <span className="radio-era-year">{era.year}</span>
              <span className="radio-era-count">{list.length} stations</span>
            </div>
            <div className="radio-grid">
              {list.map((s) => (
                <StationCard
                  key={s.id}
                  station={s}
                  playing={status === "on" && radio.stationId === s.id}
                  tuning={status === "tuning" && radio.stationId === s.id}
                  onTune={tune}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
});
