import { useCallback, useEffect, useRef } from "react"
import { useDragStore, type DragPayload } from "../stores/dragStore"

import { useProviderStore } from "../stores/providerStore"
import type { MusicProvider } from "../providers/types"

const DRAG_THRESHOLD = 6 // px of movement before drag starts

/**
 * Returns pointer-event handlers to make an element a drag source for tracks,
 * albums, or artists. Works in Tauri's WKWebView where native HTML5 drag
 * is suppressed.
 *
 * After a successful drag, a one-shot click capture listener swallows the
 * click event that the browser fires on pointer-up, preventing accidental playback.
 */
export function useTrackDrag() {
  const pointerState = useRef<{
    startX: number
    startY: number
    payload: DragPayload
    pointerId: number
    started: boolean
    provider: MusicProvider | null
    scope?: string
  } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent, payload: DragPayload) => {
      // Only primary button
      if (e.button !== 0) return
      // Don't interfere with interactive child elements (links/buttons) inside the
      // drag source. Walk from the event target up to currentTarget — if we hit an
      // <a> or <button> that is a *descendant* of the drag source, bail out.
      let node = e.target as HTMLElement | null
      const boundary = e.currentTarget as HTMLElement
      while (node && node !== boundary) {
        const tag = node.tagName
        if (tag === "A" || tag === "BUTTON") return
        node = node.parentElement
      }

      pointerState.current = {
        startX: e.clientX,
        startY: e.clientY,
        payload,
        pointerId: e.pointerId,
        started: false,
        provider: useProviderStore.getState().provider,
        scope: useProviderStore.getState().provider?.cacheScope,
      }

      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    []
  )

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = pointerState.current
    if (!s || e.pointerId !== s.pointerId) return

    if (!s.started) {
      const dx = e.clientX - s.startX
      const dy = e.clientY - s.startY
      if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
      s.started = true
      useDragStore.getState().startDrag(s.payload, e.clientX, e.clientY)
      useDragStore.getState().updateCursor(e.clientX, e.clientY)
    } else {
      useDragStore.getState().updateCursor(e.clientX, e.clientY)
    }
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const s = pointerState.current
    if (!s || e.pointerId !== s.pointerId) return
    pointerState.current = null

    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(s.pointerId)
    } catch {
      /* already released */
    }

    if (s.started) {
      const store = useDragStore.getState()
      // Pointer-up may arrive without a final move, especially under pointer capture.
      store.updateCursor(e.clientX, e.clientY)
      const currentProvider = useProviderStore.getState().provider
      const owned =
        currentProvider === s.provider &&
        currentProvider?.cacheScope === s.scope
      const targetPlaylistId = useDragStore.getState().hoveredPlaylistId
      const targetQueue = useDragStore.getState().hoveredQueue
      store.endDrag()

      // Swallow the click event that fires after pointer-up
      const swallowClick = (ev: MouseEvent) => {
        ev.stopPropagation()
        ev.preventDefault()
      }
      window.addEventListener("click", swallowClick, {
        capture: true,
        once: true,
      })
      setTimeout(
        () =>
          window.removeEventListener("click", swallowClick, { capture: true }),
        100
      )

      if (owned && (targetPlaylistId || targetQueue)) {
        window.dispatchEvent(
          new CustomEvent("plexify-media-drop", {
            detail: {
              payload: s.payload,
              provider: s.provider,
              scope: s.scope,
              targetPlaylistId,
              targetQueue,
            },
          })
        )
      }
    }
  }, [])

  useEffect(() => {
    const cancel = () => {
      const state = pointerState.current
      pointerState.current = null
      if (state?.started && useDragStore.getState().payload === state.payload)
        useDragStore.getState().endDrag()
    }
    const onCancel = (event: PointerEvent) => {
      if (pointerState.current?.pointerId === event.pointerId) cancel()
    }
    const onNativeDrag = (event: DragEvent) => {
      if (pointerState.current) event.preventDefault()
    }
    window.addEventListener("dragstart", onNativeDrag, true)
    window.addEventListener("lostpointercapture", onCancel)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("blur", cancel)
    const unsubscribe = useProviderStore.subscribe(() => {
      const state = pointerState.current
      const provider = useProviderStore.getState().provider
      if (
        state &&
        (provider !== state.provider || provider?.cacheScope !== state.scope)
      )
        cancel()
    })
    return () => {
      cancel()
      unsubscribe()
      window.removeEventListener("dragstart", onNativeDrag, true)
      window.removeEventListener("lostpointercapture", onCancel)
      window.removeEventListener("pointercancel", onCancel)
      window.removeEventListener("blur", cancel)
    }
  }, [])

  return { onPointerDown, onPointerMove, onPointerUp }
}
