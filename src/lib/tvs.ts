import { invoke } from "@tauri-apps/api/core"

/** Mirrors `TvStatus` in tvs.rs. */
export interface TvStatus {
  linked: Array<{ id: string; name: string; online: boolean; linkedAt: number }>
  /** TVs on this network that aren't linked yet. */
  nearby: Array<{ address: string; name: string }>
}

export const getTvs = () => invoke<TvStatus>("get_tvs")
export const pairTv = (address: string, code: string) => invoke<TvStatus>("pair_tv", { address, code })
export const forgetTv = (id: string) => invoke<TvStatus>("forget_tv", { id })

/** A playback message for a connected TV. Fails quietly when it has gone: the app notices that separately. */
export const sendToTv = (id: string, message: Record<string, unknown>) =>
  invoke<void>("send_to_tv", { id, message }).catch(() => {})
