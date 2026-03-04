import { useCallback, useEffect, useRef, useState } from "react"



interface UseResizableOptions {
  /** localStorage key for persistence */
  key: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
  /** "right" = handle on right edge (sidebar), "left" = handle on left edge (queue/lyrics) */
  direction: "right" | "left"
}

export function useResizable({ key, defaultWidth, minWidth, maxWidth, direction }: UseResizableOptions) {
  const [width, setWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored) {
        const n = Number(stored)
        if (!isNaN(n) && n >= minWidth && n <= maxWidth) return n
      }
    } catch { /* ignore */ }
    return defaultWidth
  })

  const [isDragging, setIsDragging] = useState(false)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const dx = direction === "right"
        ? e.clientX - startX.current
        : startX.current - e.clientX
      const w = Math.max(minWidth, Math.min(maxWidth, startW.current + dx))
      setWidth(w)
      window.dispatchEvent(new CustomEvent("resizable-change", { detail: { key, width: w } }))
    }

    const onUp = (e: MouseEvent) => {
      if (!dragging.current) return
      dragging.current = false
      setIsDragging(false)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      const dx = direction === "right"
        ? e.clientX - startX.current
        : startX.current - e.clientX
      const final = Math.max(minWidth, Math.min(maxWidth, startW.current + dx))
      try { localStorage.setItem(key, String(final)) } catch { /* ignore */ }
    }

    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
    return () => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
    }
  }, [direction, key, maxWidth, minWidth])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true
    setIsDragging(true)
    startX.current = e.clientX
    startW.current = width
    document.body.style.cursor = "ew-resize"
    document.body.style.userSelect = "none"
    e.preventDefault()
  }, [width])

  return { width, onMouseDown, isDragging }
}
