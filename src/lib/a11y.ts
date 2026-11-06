import { useEffect, type KeyboardEvent, type RefObject } from "react"

/**
 * onKeyDown for an element with role="button": Enter and Space run `action`, as they do on a
 * real button. Keys pressed on a button nested inside it are left to that button.
 */
export function activateOnKey(action: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      action()
    }
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[inert]") && el.getClientRects().length > 0,
  )
}

/** Open dialogs, innermost last; only the innermost one keeps Tab inside itself. */
const openDialogs: HTMLElement[] = []

/**
 * Dialog focus: while `active`, focus moves into the dialog (unless something inside already
 * has it), Tab and Shift+Tab stay inside, and focus goes back to where it was on close.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const dialog = ref.current
    if (!active || !dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openDialogs.push(dialog)

    if (!dialog.contains(document.activeElement)) {
      const first = focusableIn(dialog).find((el) => !el.matches("[data-dialog-close]")) ?? focusableIn(dialog)[0]
      ;(first ?? dialog).focus({ preventScroll: true })
    }

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Tab" || openDialogs[openDialogs.length - 1] !== dialog) return
      const items = focusableIn(dialog)
      if (items.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      if (e.shiftKey && (current === first || !dialog.contains(current))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (current === last || !dialog.contains(current))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      openDialogs.splice(openDialogs.indexOf(dialog), 1)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [ref, active])
}
