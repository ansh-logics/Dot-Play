import { useSyncExternalStore } from "react";

/**
 * A tiny store an embed page exposes as `window.dmControl`, so the parent page (same origin)
 * can drive it from scroll: `iframe.contentWindow.dmControl.set({ ... })`.
 */
export function createControl<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  const control = {
    get: () => state,
    set(patch: Partial<T>) {
      let changed = false;
      for (const k in patch) {
        if (!Object.is(patch[k], state[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      subs.forEach((fn) => fn());
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  (window as unknown as { dmControl: typeof control }).dmControl = control;
  const useControl = () => useSyncExternalStore(control.subscribe, control.get);
  return { control, useControl };
}

/** Makes the app's `isTauriEnvironment()` true, so its components use the mock bridge. */
export function pretendTauri() {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
}
