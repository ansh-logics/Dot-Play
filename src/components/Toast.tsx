import { useEffect } from "react"
import { Info } from "lucide-react"

interface ToastProps {
  message: string | null
  onDismiss: () => void
  duration?: number
}

export function Toast({ message, onDismiss, duration = 3000 }: ToastProps) {
  useEffect(() => {
    if (!message) return

    const timer = setTimeout(() => {
      onDismiss()
    }, duration)

    return () => clearTimeout(timer)
  }, [message, onDismiss, duration])

  if (!message) return null

  return (
    <div
      className="nothing-toast-container"
      role="status"
      aria-live="polite"
      onClick={onDismiss}
    >
      <div className="nothing-toast-card">
        <span className="dot-red-accent small" />
        <Info size={14} className="nothing-toast-icon" />
        <span className="nothing-toast-text">{message}</span>
      </div>
    </div>
  )
}
