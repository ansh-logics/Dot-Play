import { useSyncExternalStore } from "react";
import { getSkin, subscribeSkin, type PlayerSkinId } from "./playerSkins";

/** The player style chosen on the Now Playing wheel, kept in sync across the app. */
export function usePlayerSkin(): PlayerSkinId {
  return useSyncExternalStore(subscribeSkin, getSkin);
}
