import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Settings } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Modal } from "./Modal";
import type { FeedbackPrefs } from "../../lib/feedback";
import { IDLE_CHOICES, IS_MAC, openImmersive, type IdleMinutes } from "../../lib/immersive";
import { ImmersiveDisplays } from "./ImmersiveDisplays";
import { PhoneRemoteSettings } from "./PhoneRemoteSettings";
import { ScrobbleSettings } from "./ScrobbleSettings";
import { CROSSFADE_CHOICES, setCrossfadeSeconds, useCrossfadeSeconds } from "../../lib/crossfade";
import { isTauriEnvironment } from "../../lib/search";
import {
  DEFAULT_PROVIDERS,
  readProviderSettings,
  resetProviderSettings,
  writeProviderSettings,
  type ProviderSetting,
} from "../../lib/lyricsPrefs";
import {
  setDiscordPresenceEnabled,
  useDiscordPresenceAvailable,
  useDiscordPresenceEnabled,
  useDiscordPresenceStatus,
  type DiscordPresenceStatus,
} from "../../lib/discordPresence";

interface SettingsModalProps {
  feedbackPrefs: FeedbackPrefs;
  onFeedbackChange: (patch: Partial<FeedbackPrefs>) => void;
  immersiveIdle: IdleMinutes;
  onImmersiveIdleChange: (minutes: IdleMinutes) => void;
  isLoggedIn: boolean;
  accountEmail: string | undefined;
  onSignOut: () => void;
  onClose: () => void;
}

interface SwitchRowProps {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}

function SwitchRow({ label, description, checked, onToggle }: SwitchRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-label">{label}</span>
        <span className="settings-desc">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`settings-switch ${checked ? "on" : ""}`}
        onClick={onToggle}
      >
        <span className="settings-switch-knob" />
      </button>
    </div>
  );
}

function clearArtworkCache() {
  localStorage.removeItem("dot_verified_artwork_cache");
  localStorage.removeItem("dot_music_track_metadata_cache");
  window.location.reload();
}

export function SettingsModal({
  feedbackPrefs,
  onFeedbackChange,
  immersiveIdle,
  onImmersiveIdleChange,
  isLoggedIn,
  accountEmail,
  onSignOut,
  onClose,
}: SettingsModalProps) {
  return (
    <Modal
      title="Settings"
      icon={<Settings size={18} strokeWidth={2} className="modal-title-icon" />}
      onClose={onClose}
    >
      <div className="settings-section">
        <span className="settings-section-title">AUDIO ENGINE</span>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">Stream Quality</span>
            <span className="settings-desc">
              YouTube's player picks the audio stream for each song. DOT Music can't choose it or see its bitrate.
            </span>
          </div>
          <span className="settings-badge">SET BY YOUTUBE</span>
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">PLAYER</span>
        <CrossfadeRow />
        <SwitchRow
          label="Player sounds"
          description="Clicks on the player-style wheel, and the Cassette deck's keys, motor and tape"
          checked={feedbackPrefs.sound}
          onToggle={() => onFeedbackChange({ sound: !feedbackPrefs.sound })}
        />
        <SwitchRow
          label="Trackpad haptics"
          description="Feel each notch on a Force Touch trackpad"
          checked={feedbackPrefs.haptics}
          onToggle={() => onFeedbackChange({ haptics: !feedbackPrefs.haptics })}
        />
      </div>

      <LyricsSources />

      <div className="settings-section">
        <span className="settings-section-title">IMMERSIVE MODE</span>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">Clock and song on your displays</span>
            <span className="settings-desc">Press I anywhere in the app. Esc steps back to the player.</span>
          </div>
          <button
            type="button"
            className="settings-action-btn"
            onClick={() => {
              onClose();
              openImmersive();
            }}
          >
            Start
          </button>
        </div>
        <ImmersiveDisplays />
        {IS_MAC && (
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-label">Start when idle</span>
              <span className="settings-desc">Like a screensaver, while music plays. Any key or mouse move ends it.</span>
            </div>
            <div className="settings-segmented" role="radiogroup" aria-label="Start when idle">
              {IDLE_CHOICES.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  role="radio"
                  aria-checked={immersiveIdle === minutes}
                  className={immersiveIdle === minutes ? "is-on" : undefined}
                  onClick={() => onImmersiveIdleChange(minutes)}
                >
                  {minutes === 0 ? "Off" : `${minutes}m`}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <PhoneRemoteSettings />

      <DiscordSettings />

      <ScrobbleSettings />

      <div className="settings-section">
        <span className="settings-section-title">DATA & STORAGE</span>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">Track & Artwork Cache</span>
            <span className="settings-desc">Optimized WebP local cache for fast loading</span>
          </div>
          <button type="button" className="settings-action-btn" onClick={clearArtworkCache}>
            Clear Cache
          </button>
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">ACCOUNT</span>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">Status</span>
            <span className="settings-desc">
              {isLoggedIn ? accountEmail || "Connected to YouTube Music" : "Offline (Guest Mode)"}
            </span>
          </div>
          {isLoggedIn ? (
            <button
              type="button"
              className="settings-action-btn"
              onClick={() => {
                onClose();
                onSignOut();
              }}
              style={{ color: "var(--red-primary, #ff0055)" }}
            >
              Sign Out
            </button>
          ) : (
            <span className="settings-status-pill offline">OFFLINE</span>
          )}
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-section-title">ABOUT</span>
        <div className="settings-about-box">
          <span className="about-app-name">dot(.)music</span>
          <span className="about-app-ver">Version {__APP_VERSION__} • Nothing OS Minimalist Design</span>
        </div>
      </div>
    </Modal>
  );
}

/** The order lyrics providers are tried in, and which ones are on. */
function LyricsSources() {
  const [known, setKnown] = useState<string[]>(DEFAULT_PROVIDERS);
  const [settings, setSettings] = useState<ProviderSetting[]>(() => readProviderSettings(DEFAULT_PROVIDERS));

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let cancelled = false;
    void invoke<string[]>("lyrics_providers")
      .then((names) => {
        if (cancelled || !Array.isArray(names)) return;
        const list = names.filter((name): name is string => typeof name === "string" && name.length > 0);
        if (list.length === 0) return;
        setKnown(list);
        setSettings(readProviderSettings(list));
      })
      .catch((err: unknown) => {
        console.warn("[DOT Music] lyrics_providers failed, using the default order:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enabledCount = settings.filter((setting) => setting.on).length;

  const update = (next: ProviderSetting[]) => {
    setSettings(next);
    writeProviderSettings(next);
  };

  const toggle = (index: number) => {
    const setting = settings[index];
    if (!setting || (setting.on && enabledCount <= 1)) return;
    update(settings.map((item, i) => (i === index ? { ...item, on: !item.on } : item)));
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= settings.length) return;
    const next = [...settings];
    [next[index], next[target]] = [next[target], next[index]];
    update(next);
  };

  const reset = () => {
    resetProviderSettings();
    setSettings(readProviderSettings(known));
  };

  return (
    <div className="settings-section">
      <span className="settings-section-title">LYRICS SOURCES</span>
      <span className="settings-note">Tried in this order when a song's lyrics load. At least one stays on.</span>
      {settings.map((setting, index) => (
        <div className="settings-row settings-lyrics-source" key={setting.name}>
          <div className="settings-row-text">
            <span className="settings-label">{setting.name}</span>
          </div>
          <div className="settings-lyrics-actions">
            <button
              type="button"
              className="settings-icon-btn"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              aria-label={`Move ${setting.name} up`}
              title="Move up"
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              className="settings-icon-btn"
              onClick={() => move(index, 1)}
              disabled={index === settings.length - 1}
              aria-label={`Move ${setting.name} down`}
              title="Move down"
            >
              <ChevronDown size={16} />
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={setting.on}
              aria-label={`${setting.name} lyrics source`}
              className={`settings-switch ${setting.on ? "on" : ""}`}
              disabled={setting.on && enabledCount <= 1}
              onClick={() => toggle(index)}
            >
              <span className="settings-switch-knob" />
            </button>
          </div>
        </div>
      ))}
      <div className="settings-lyrics-reset">
        <button type="button" className="settings-action-btn" onClick={reset}>
          Reset to default
        </button>
      </div>
    </div>
  );
}

/** Discord status: what's playing, shown on the listener's Discord profile. Off by default. */
function DiscordSettings() {
  const available = useDiscordPresenceAvailable();
  const enabled = useDiscordPresenceEnabled();
  const status = useDiscordPresenceStatus();
  if (available === null) return null;
  return (
    <div className="settings-section">
      <span className="settings-section-title">DISCORD</span>
      {available ? (
        <SwitchRow
          label="Show what you're listening to"
          description={enabled ? discordStatusText(status) : "Your Discord profile shows the song while it plays, through the Discord app on this Mac. Pausing clears it."}
          checked={enabled}
          onToggle={() => setDiscordPresenceEnabled(!enabled)}
        />
      ) : (
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label">Show what you're listening to</span>
            <span className="settings-desc">Not available in this build.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** What the Discord row says while the switch is on, so a missing status explains itself. */
function discordStatusText(status: DiscordPresenceStatus): string {
  switch (status.kind) {
    case "shown":
      return `Showing “${status.title}” on your Discord profile.`;
    case "cleared":
      return "Connected to Discord. The status shows while a song plays.";
    case "no-discord":
      return "Couldn't reach the Discord app. Open Discord; DOT Music tries again every 30 seconds.";
    case "error":
      return `Discord didn't accept the status: ${status.message}`;
    default:
      return "Play a song to show it on your Discord profile.";
  }
}

function CrossfadeRow() {
  const seconds = useCrossfadeSeconds();
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-label">Crossfade</span>
        <span className="settings-desc">Blend the end of each song into the next. Not with repeat one or "stop after this song".</span>
      </div>
      <div className="settings-segmented" role="radiogroup" aria-label="Crossfade">
        {CROSSFADE_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={seconds === choice}
            className={seconds === choice ? "is-on" : undefined}
            onClick={() => setCrossfadeSeconds(choice)}
          >
            {choice === 0 ? "Off" : `${choice}s`}
          </button>
        ))}
      </div>
    </div>
  );
}

