import { useCallback, useEffect, useRef, useState } from "react";
import type { LyricsPayload } from "../lib/lyrics";
import type { RemoteTrack, TrayCommand, TrayState } from "../lib/useTrayBridge";
import { DEVICE_INFO, PAIR_INFO, deriveKey, fromBase64Url, open, randomBytes, seal, toBase64Url, toHex } from "./crypto";

/** `NowPlayingSnapshot` from media_controls.rs, plus how old its position was when sent. */
export interface RemoteNowPlaying {
  title: string;
  artist: string;
  duration: number;
  position: number;
  isPlaying: boolean;
  artworkUrl: string | null;
  videoId: string | null;
  ageMs: number;
  /** When this phone received it (its own clock). */
  receivedAt: number;
}

export type RemoteQueueState = TrayState & { total?: number };

export type Connection =
  | { kind: "checking" }
  /** Not paired: scan the QR code on the Mac. */
  | { kind: "unpaired"; message?: string }
  /** Waiting for the Mac to allow this phone. */
  | { kind: "waiting" }
  | { kind: "connected" }
  | { kind: "reconnecting" }
  /** The relay is reachable but the Mac isn't connected to it. */
  | { kind: "macOffline" };

export type MediaAction = { action: "toggle" | "next" | "previous" } | { action: "seek"; position: number };

export interface LyricsQuery {
  videoId?: string;
  title: string;
  artist: string;
  duration?: number;
}

/** This phone's pairing with one Mac, kept between visits. */
interface Pairing {
  room: string;
  peer: string;
  /** The device secret, base64url. */
  secret: string;
  /** "mac" or "pc": what the paired computer is called on screen. */
  os?: HostOs;
}

export type HostOs = "mac" | "pc";

/** "Mac" for a Mac; "computer" for Windows, or before we know. */
export function computerWord(os: HostOs | undefined): string {
  return os === "mac" ? "Mac" : "computer";
}

const asHostOs = (value: unknown): HostOs | undefined => (value === "mac" || value === "pc" ? value : undefined);

const STORE_KEY = "dot-music-remote";
/** The last track and queue seen, shown instantly on reopen while the connection comes back. */
const LAST_KEY = "dot-music-remote-last";
/** Reconnect delays: first retry at once, then a little longer, never more than a few seconds. */
const BACKOFF_MS = [0, 300, 1000, 2000, 4000];
/** The relay answers "ping" with "pong" itself; silence this long means the socket is dead. */
const PING_EVERY_MS = 15_000;
const SILENCE_LIMIT_MS = 35_000;
/** After coming back to the page, a socket that doesn't answer this fast is replaced. */
const RESUME_PROBE_MS = 1500;
export type SearchHit = RemoteTrack & { duration?: string | null };

function loadLast(): { np: RemoteNowPlaying | null; state: RemoteQueueState | null } {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as {
      np: RemoteNowPlaying | null;
      state: RemoteQueueState | null;
    } | null;
    // The old position can't be trusted until the Mac answers, so show it paused.
    return { np: value?.np ? { ...value.np, isPlaying: false, ageMs: 0, receivedAt: Date.now() } : null, state: value?.state ?? null };
  } catch {
    return { np: null, state: null };
  }
}

function saveLast(np: RemoteNowPlaying | null, state: RemoteQueueState | null) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ np, state }));
  } catch {
    // Storage full or private browsing: only the instant reopen is lost.
  }
}
/** Closed by the relay because the Mac disconnected this phone. */
const KICKED = 4001;
const PAIR_TIMEOUT_MS = 100_000;

function loadPairing(): Pairing | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Pairing | null;
    return value?.room && value.peer && value.secret ? value : null;
  } catch {
    return null;
  }
}

function savePairing(pairing: Pairing | null) {
  try {
    if (pairing) localStorage.setItem(STORE_KEY, JSON.stringify(pairing));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Private browsing: the pairing lasts for this visit only.
  }
}

/**
 * Read once when the page loads (React may run effects twice): a QR link carries
 * #r=<room>&p=<pairing secret>, which is then dropped from the address bar so it never ends
 * up in history or a bookmark.
 */
const START = (() => {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const linkRoom = hash.get("r");
  const linkSecret = hash.get("p");
  const linkOs = asHostOs(hash.get("o"));
  if (linkRoom || linkSecret) window.history.replaceState(null, "", window.location.pathname);
  const saved = loadPairing();
  if (linkRoom && linkSecret && /^[a-f0-9]{32}$/.test(linkRoom) && saved?.room !== linkRoom) {
    return {
      pairing: { room: linkRoom, peer: toHex(randomBytes(16)), secret: toBase64Url(randomBytes(32)), os: linkOs } as Pairing,
      pairKeySecret: fromBase64Url(linkSecret) as Uint8Array | null,
      os: linkOs,
    };
  }
  return { pairing: saved, pairKeySecret: null as Uint8Array | null, os: saved?.os ?? linkOs };
})();

/** "iPhone", "Android phone"… for the Mac's "Allow …?" prompt. */
function deviceName(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("iphone")) return "iPhone";
  if (ua.includes("ipad")) return "iPad";
  if (ua.includes("android")) return ua.includes("mobile") ? "Android phone" : "Android tablet";
  return "Phone";
}

/**
 * The connection to the Mac through the relay: pairing, live track and queue updates,
 * commands and lyrics, all sealed end to end. Reconnects on its own after Wi-Fi blips,
 * the phone sleeping or the Mac going offline.
 */
export function useRemoteState() {
  const [connection, setConnection] = useState<Connection>({ kind: "checking" });
  const [hostOs, setHostOs] = useState<HostOs | undefined>(START.os);
  const [cached] = useState(() => (START.pairing && !START.pairKeySecret ? loadLast() : { np: null, state: null }));
  const [np, setNp] = useState<RemoteNowPlaying | null>(cached.np);
  const [state, setState] = useState<RemoteQueueState | null>(cached.state);
  useEffect(() => {
    if (connection.kind === "connected") saveLast(np, state);
  }, [connection.kind, np, state]);

  const socketRef = useRef<WebSocket | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const pairingRef = useRef<Pairing | null>(null);
  const seqRef = useRef(0);
  const lyricsWaiters = useRef(new Map<number, (payload: LyricsPayload | null) => void>());
  const nextLyricsId = useRef(1);
  const searchWaiters = useRef(new Map<number, (results: SearchHit[] | null) => void>());
  const nextSearchId = useRef(1);

  const sendSealed = useCallback(async (message: Record<string, unknown>) => {
    const socket = socketRef.current;
    const key = keyRef.current;
    const pairing = pairingRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !key || !pairing) return;
    // Strictly increasing, even across reloads, so the Mac can refuse replays.
    seqRef.current = Math.max(seqRef.current + 1, Date.now() * 1000);
    const sealed = await seal(key, `${pairing.peer}|up`, JSON.stringify({ ...message, seq: seqRef.current }));
    socket.send(JSON.stringify({ m: sealed }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer = 0;
    let pairTimer = 0;
    let probeTimer = 0;
    let attempt = 0;
    let lastHeard = Date.now();

    const pairing = START.pairing;
    /** Set while this phone still has to ask the Mac. */
    let pairKeySecret = START.pairKeySecret;
    if (!pairing) {
      setConnection({ kind: "unpaired" });
      return;
    }
    const current = pairing;
    pairingRef.current = current;

    const word = () => computerWord(current.os);
    const finishUnpaired = (message: string) => {
      savePairing(null);
      try {
        localStorage.removeItem(LAST_KEY);
      } catch {
        // nothing to clear
      }
      pairingRef.current = null;
      setNp(null);
      setState(null);
      setConnection({ kind: "unpaired", message });
    };

    const onMessage = async (raw: string) => {
      lastHeard = Date.now();
      if (raw === "pong") return;
      let frame: { host?: string; m?: string };
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (frame.host === "offline") {
        setConnection({ kind: "macOffline" });
        return;
      }
      if (frame.host === "online") {
        if (pairKeySecret) {
          const pairKey = await deriveKey(pairKeySecret, PAIR_INFO);
          const sealed = await seal(pairKey, `${current.peer}|pair`, JSON.stringify({ name: deviceName(), secret: current.secret }));
          socketRef.current?.send(JSON.stringify({ pair: sealed }));
          setConnection({ kind: "waiting" });
          window.clearTimeout(pairTimer);
          pairTimer = window.setTimeout(() => {
            if (pairKeySecret) finishUnpaired(`Your ${word()} didn't answer. Scan the QR code in Settings again.`);
            socketRef.current?.close();
          }, PAIR_TIMEOUT_MS);
        } else {
          setConnection({ kind: "connected" });
          void sendSealed({ type: "hello" });
        }
        return;
      }
      if (typeof frame.m !== "string" || !keyRef.current) return;
      const plain = await open(keyRef.current, `${current.peer}|down`, frame.m);
      if (!plain) return;
      const message = JSON.parse(plain) as {
        type: string;
        data?: unknown;
        id?: number;
        payload?: LyricsPayload | null;
        results?: SearchHit[];
      };
      switch (message.type) {
        case "paired":
          pairKeySecret = null;
          window.clearTimeout(pairTimer);
          savePairing(current);
          setConnection({ kind: "connected" });
          break;
        case "denied":
          pairKeySecret = null;
          window.clearTimeout(pairTimer);
          finishUnpaired(`Your ${word()} didn't allow this phone.`);
          break;
        case "revoked":
          finishUnpaired(`This phone was disconnected on your ${word()}.`);
          break;
        case "nowPlaying": {
          const data = message.data as Omit<RemoteNowPlaying, "receivedAt"> | null;
          setNp(data ? { ...data, receivedAt: Date.now() } : null);
          break;
        }
        case "state":
          setState(message.data as RemoteQueueState);
          break;
        case "host": {
          const os = asHostOs((message as { os?: unknown }).os);
          if (os && os !== current.os) {
            current.os = os;
            setHostOs(os);
            if (!pairKeySecret) savePairing(current);
          }
          break;
        }
        case "lyrics":
          if (typeof message.id === "number") {
            lyricsWaiters.current.get(message.id)?.(message.payload ?? null);
            lyricsWaiters.current.delete(message.id);
          }
          break;
        case "search":
          if (typeof message.id === "number") {
            searchWaiters.current.get(message.id)?.(Array.isArray(message.results) ? message.results : []);
            searchWaiters.current.delete(message.id);
          }
          break;
      }
    };

    const connect = () => {
      if (disposed) return;
      window.clearTimeout(retryTimer);
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${window.location.host}/room/${current.room}?role=client&peer=${current.peer}`);
      socketRef.current = socket;
      lastHeard = Date.now();
      socket.addEventListener("open", () => {
        attempt = 0;
        lastHeard = Date.now();
      });
      socket.addEventListener("message", (e) => void onMessage(String(e.data)));
      socket.addEventListener("close", (e) => {
        if (disposed || socketRef.current !== socket) return;
        if (e.code === KICKED) {
          if (pairingRef.current) finishUnpaired(`This phone was disconnected on your ${word()}.`);
          return;
        }
        if (!pairingRef.current) return;
        setConnection((c) => (c.kind === "macOffline" ? c : { kind: "reconnecting" }));
        retryTimer = window.setTimeout(connect, BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
        attempt++;
      });
    };

    /** Drop the current socket without waiting for it to time out, and open a new one. */
    const reconnectNow = () => {
      if (disposed || !pairingRef.current) return;
      const old = socketRef.current;
      socketRef.current = null;
      old?.close();
      attempt = 0;
      setConnection((c) => (c.kind === "connected" ? { kind: "reconnecting" } : c));
      connect();
    };

    // A socket can die without closing (phone asleep, Wi-Fi to mobile data). The relay answers
    // pings itself, so silence means it's gone.
    const heartbeat = window.setInterval(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || document.visibilityState !== "visible") return;
      if (Date.now() - lastHeard > SILENCE_LIMIT_MS) reconnectNow();
      else socket.send("ping");
    }, PING_EVERY_MS);

    void deriveKey(fromBase64Url(current.secret), DEVICE_INFO).then((key) => {
      if (disposed) return;
      keyRef.current = key;
      connect();
    });

    // Back to the page (unlocked, tab switched back, network changed): phones suspend sockets
    // in the background, so check at once instead of waiting for a timeout. An open socket
    // gets a ping; if nothing comes back quickly it's replaced.
    const onResume = () => {
      if (document.visibilityState !== "visible" || !pairingRef.current || disposed) return;
      const socket = socketRef.current;
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        reconnectNow();
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      const sentAt = Date.now();
      socket.send("ping");
      void sendSealed({ type: "hello" });
      window.clearTimeout(probeTimer);
      probeTimer = window.setTimeout(() => {
        if (lastHeard < sentAt) reconnectNow();
      }, RESUME_PROBE_MS);
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", reconnectNow);

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(pairTimer);
      window.clearTimeout(probeTimer);
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", reconnectNow);
      socketRef.current?.close();
    };
  }, [sendSealed]);

  const send = useCallback((command: TrayCommand | MediaAction) => void sendSealed({ type: "cmd", cmd: command }), [sendSealed]);

  const requestLyrics = useCallback(
    (q: LyricsQuery) =>
      new Promise<LyricsPayload | null>((resolve) => {
        const id = nextLyricsId.current++;
        lyricsWaiters.current.set(id, resolve);
        void sendSealed({ type: "lyrics", id, q });
        window.setTimeout(() => {
          if (lyricsWaiters.current.delete(id)) resolve(null);
        }, 20_000);
      }),
    [sendSealed],
  );

  /** Songs for a search box; null if the Mac didn't answer in time. */
  const requestSearch = useCallback(
    (query: string) =>
      new Promise<SearchHit[] | null>((resolve) => {
        const id = nextSearchId.current++;
        searchWaiters.current.set(id, resolve);
        void sendSealed({ type: "search", id, q: query });
        window.setTimeout(() => {
          if (searchWaiters.current.delete(id)) resolve(null);
        }, 10_000);
      }),
    [sendSealed],
  );

  return { connection, np, state, send, requestLyrics, requestSearch, computer: computerWord(hostOs) };
}

/** Elapsed seconds, extrapolated while playing; re-renders a few times a second. */
export function usePosition(np: RemoteNowPlaying | null): number {
  const [now, setNow] = useState(() => Date.now());
  const playing = np?.isPlaying ?? false;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [playing]);
  if (!np) return 0;
  const elapsed = np.isPlaying ? (np.ageMs + Math.max(0, now - np.receivedAt)) / 1000 : 0;
  const t = np.position + elapsed;
  return np.duration > 0 ? Math.min(t, np.duration) : t;
}
