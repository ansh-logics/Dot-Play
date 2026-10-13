import { useCallback, useEffect, useRef } from "react";

/**
 * Edge auto-scroll for a scrollable list while one of its items is being
 * drag-reordered. Attach `listRef` to the scroll container and pass
 * `onDragStateChange` to each UpcomingQueueItem.
 */
export function useDragAutoScroll<T extends HTMLElement = HTMLDivElement>() {
  const queueListRef = useRef<T>(null);
  const isQueueDraggingRef = useRef(false);
  const queuePointerYRef = useRef<number | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    queuePointerYRef.current = null;
  }, []);

  const startAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) return;

    const scrollStep = () => {
      if (!isQueueDraggingRef.current) {
        stopAutoScroll();
        return;
      }

      const container = queueListRef.current;
      if (container && queuePointerYRef.current !== null) {
        const rect = container.getBoundingClientRect();
        const pointerY = queuePointerYRef.current;
        const edgeThreshold = 36;

        if (pointerY >= rect.bottom - edgeThreshold && pointerY <= rect.bottom + 50) {
          // Slowly auto-scroll down
          const factor = Math.min(1, Math.max(0.2, (pointerY - (rect.bottom - edgeThreshold)) / edgeThreshold));
          container.scrollTop += 2.5 * factor;
        } else if (pointerY <= rect.top + edgeThreshold && pointerY >= rect.top - 50) {
          // Slowly auto-scroll up
          const factor = Math.min(1, Math.max(0.2, ((rect.top + edgeThreshold) - pointerY) / edgeThreshold));
          container.scrollTop -= 2.5 * factor;
        }
      }

      autoScrollRafRef.current = requestAnimationFrame(scrollStep);
    };

    autoScrollRafRef.current = requestAnimationFrame(scrollStep);
  }, [stopAutoScroll]);

  const handleQueueDragStateChange = useCallback(
    (isDragging: boolean) => {
      isQueueDraggingRef.current = isDragging;
      if (isDragging) {
        startAutoScroll();
      } else {
        stopAutoScroll();
      }
    },
    [startAutoScroll, stopAutoScroll],
  );

  useEffect(() => {
    const handleWindowPointerMove = (e: PointerEvent) => {
      if (isQueueDraggingRef.current) {
        queuePointerYRef.current = e.clientY;
      }
    };

    const handleWindowPointerEnd = () => {
      if (isQueueDraggingRef.current) {
        isQueueDraggingRef.current = false;
        stopAutoScroll();
      }
    };

    window.addEventListener("pointermove", handleWindowPointerMove, { passive: true });
    window.addEventListener("pointerup", handleWindowPointerEnd, { passive: true });
    window.addEventListener("pointercancel", handleWindowPointerEnd, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerEnd);
      window.removeEventListener("pointercancel", handleWindowPointerEnd);
      stopAutoScroll();
    };
  }, [stopAutoScroll]);

  return { listRef: queueListRef, onDragStateChange: handleQueueDragStateChange };
}
