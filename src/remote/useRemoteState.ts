import { useCallback, useEffect, useRef, useState } from "react";
import type { LyricsPayload } from "../lib/lyrics";
import type { TrayCommand, TrayState } from "../lib/useTrayBridge";
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
}

const STORE_KEY = "dot-music-remote";
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
  if (linkRoom || linkSecret) window.history.replaceState(null, "", window.location.pathname);
  const saved = loadPairing();
  if (linkRoom && linkSecret && /^[a-f0-9]{32}$/.test(linkRoom) && saved?.room !== linkRoom) {
    return {
      pairing: { room: linkRoom, peer: toHex(randomBytes(16)), secret: toBase64Url(randomBytes(32)) } as Pairing,
      pairKeySecret: fromBase64Url(linkSecret) as Uint8Array | null,
    };
  }
  return { pairing: saved, pairKeySecret: null as Uint8Array | null };
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
  const [np, setNp] = useState<RemoteNowPlaying | null>(null);
  const [state, setState] = useState<RemoteQueueState | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const pairingRef = useRef<Pairing | null>(null);
  const seqRef = useRef(0);
  const lyricsWaiters = useRef(new Map<number, (payload: LyricsPayload | null) => void>());
  const nextLyricsId = useRef(1);

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
    let backoff = 1000;

    const pairing = START.pairing;
    /** Set while this phone still has to ask the Mac. */
    let pairKeySecret = START.pairKeySecret;
    if (!pairing) {
      setConnection({ kind: "unpaired" });
      return;
    }
    const current = pairing;
    pairingRef.current = current;

    const finishUnpaired = (message: string) => {
      savePairing(null);
      pairingRef.current = null;
      setNp(null);
      setState(null);
      setConnection({ kind: "unpaired", message });
    };

    const onMessage = async (raw: string) => {
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
            if (pairKeySecret) finishUnpaired("The Mac didn't answer. Scan the QR code in Settings again.");
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
      const message = JSON.parse(plain) as { type: string; data?: unknown; id?: number; payload?: LyricsPayload | null };
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
          finishUnpaired("The Mac didn't allow this phone.");
          break;
        case "revoked":
          finishUnpaired("This phone was disconnected on the Mac.");
          break;
        case "nowPlaying": {
          const data = message.data as Omit<RemoteNowPlaying, "receivedAt"> | null;
          setNp(data ? { ...data, receivedAt: Date.now() } : null);
          break;
        }
        case "state":
          setState(message.data as RemoteQueueState);
          break;
        case "lyrics":
          if (typeof message.id === "number") {
            lyricsWaiters.current.get(message.id)?.(message.payload ?? null);
            lyricsWaiters.current.delete(message.id);
          }
          break;
      }
    };

    const connect = () => {
      if (disposed) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${window.location.host}/room/${current.room}?role=client&peer=${current.peer}`);
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        backoff = 1000;
      });
      socket.addEventListener("message", (e) => void onMessage(String(e.data)));
      socket.addEventListener("close", (e) => {
        if (disposed || socketRef.current !== socket) return;
        if (e.code === KICKED) {
          if (pairingRef.current) finishUnpaired("This phone was disconnected on the Mac.");
          return;
        }
        if (!pairingRef.current) return;
        setConnection((c) => (c.kind === "macOffline" ? c : { kind: "reconnecting" }));
        retryTimer = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      });
    };

    void deriveKey(fromBase64Url(current.secret), DEVICE_INFO).then((key) => {
      if (disposed) return;
      keyRef.current = key;
      connect();
    });

    // Back from the background (phones suspend sockets): reconnect straight away.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !pairingRef.current) return;
      const socket = socketRef.current;
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        window.clearTimeout(retryTimer);
        connect();
      } else {
        void sendSealed({ type: "hello" });
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(pairTimer);
      document.removeEventListener("visibilitychange", onVisible);
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

  return { connection, np, state, send, requestLyrics };
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
