import { invoke } from "@tauri-apps/api/core"

/** Mirrors `RemoteStatus` in remote.rs. */
export interface RemoteStatus {
  enabled: boolean
  /** The Mac's connection to the relay; "unconfigured" when this build has no relay address. */
  relay: "connecting" | "online" | "offline" | "unconfigured"
  /** The pairing link the QR code encodes. */
  url: string | null
  qrSvg: string | null
  devices: Array<{ id: string; name: string; pairedAt: number }>
  clients: number
}

export interface PairRequest {
  id: string
  name: string
}

export const getRemoteStatus = () => invoke<RemoteStatus>("get_remote_status")
export const setRemoteEnabled = (enabled: boolean) => invoke<RemoteStatus>("set_remote_enabled", { enabled })
export const answerPairRequest = (id: string, allow: boolean) => invoke<void>("answer_pair_request", { id, allow })
export const forgetRemoteDevice = (id: string) => invoke<RemoteStatus>("forget_remote_device", { id })
