import { useEffect } from "react"

/**
 * Moving around with a TV remote. Screens mark each horizontal group of buttons with
 * `data-nav-row`; Left and Right move within a row, Up and Down between rows (back to where
 * that row was left, or else the button nearest above or below). OK presses the focused
 * button, as the browser does anyway.
 *
 * `screen` names what is showing: when it changes, focus goes to where that screen was left
 * (`data-nav-id`), or to `data-nav-default`, or to the first button.
 */

const lastFocused = new Map<string, string>()

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-nav-row]")].filter((row) => buttons(row).length > 0)
}

function buttons(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>("button:not(:disabled)")]
}

function focus(element: HTMLElement | undefined) {
  if (!element) return
  element.focus({ preventScroll: true })
  element.scrollIntoView({ block: "center", inline: "center" })
}

function nearest(candidates: HTMLElement[], to: HTMLElement): HTMLElement | undefined {
  const box = to.getBoundingClientRect()
  const x = box.left + box.width / 2
  let best: HTMLElement | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect()
    const distance = Math.abs(rect.left + rect.width / 2 - x)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

export function useDpad(screen: string, ready: boolean) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return
      const all = rows()
      if (all.length === 0) return
      event.preventDefault()
      const active = document.activeElement as HTMLElement | null
      const row = active?.closest<HTMLElement>("[data-nav-row]")
      if (!active || !row) {
        focus(buttons(all[0])[0])
        return
      }
      const inRow = buttons(row)
      const at = inRow.indexOf(active)
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        focus(inRow[at + (event.key === "ArrowRight" ? 1 : -1)])
        return
      }
      const target = all[all.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)]
      if (!target) return
      row.dataset.navAt = String(at)
      const candidates = buttons(target)
      const remembered = target.dataset.navAt === undefined ? undefined : candidates[Number(target.dataset.navAt)]
      focus(remembered ?? nearest(candidates, active))
    }
    function onFocus(event: FocusEvent) {
      const id = (event.target as HTMLElement | null)?.dataset?.navId
      if (id) lastFocused.set(screen, id)
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("focusin", onFocus)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("focusin", onFocus)
    }
  }, [screen])

  useEffect(() => {
    if (!ready) return
    const frame = requestAnimationFrame(() => {
      const remembered = lastFocused.get(screen)
      const element =
        (remembered ? document.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(remembered)}"]`) : null) ??
        document.querySelector<HTMLElement>("[data-nav-default]") ??
        document.querySelector<HTMLElement>("[data-nav-row] button:not(:disabled)")
      focus(element ?? undefined)
    })
    return () => cancelAnimationFrame(frame)
  }, [screen, ready])
}
