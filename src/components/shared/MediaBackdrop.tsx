import { useEffect, useId, useState, type RefObject } from "react"
import { useLocation } from "wouter"
import { useScrollContainer } from "../../lib/scrollContainer"
import { useAmbientArtworkClaim } from "../../hooks/useAmbientArtwork"
import type { AmbientArtwork } from "../../stores/ambientArtworkStore"

/** Give the full-window background the current detail artwork and hero geometry. */
export function MediaBackdrop({
  src,
  heroRef,
  position = "50% 50%",
  onFailure,
}: {
  src: string | null
  heroRef: RefObject<HTMLDivElement | null>
  position?: string
  onFailure?: (url: string) => void
}) {
  const owner = useId()
  const [route] = useLocation()
  const scrollerRef = useScrollContainer()
  const [align, setAlign] = useState<AmbientArtwork["align"]>()
  useAmbientArtworkClaim(
    owner,
    src ? { src, position, route, align, onFailure } : null
  )
  // Passive effects see both the sibling hero and parent scroll refs attached.
  useEffect(() => {
    const hero = heroRef.current,
      scroller = scrollerRef?.current
    if (!hero || !scroller) return
    let pending = 0
    const measure = () => {
      pending = 0
      const rect = hero.getBoundingClientRect()
      const next = {
        heroW: rect.width,
        heroH: rect.height,
        heroTop: rect.top + scroller.scrollTop,
        heroLeft: rect.left,
        scrollTop: Math.max(0, scroller.scrollTop),
      }
      setAlign((previous) =>
        previous &&
        Object.keys(next).every(
          (key) =>
            previous[key as keyof typeof next] ===
            next[key as keyof typeof next]
        )
          ? previous
          : next
      )
    }
    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(measure)
    }
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null
    observer?.observe(hero)
    observer?.observe(scroller)
    window.addEventListener("resize", schedule)
    window.addEventListener("resizable-change", schedule)
    scroller.addEventListener("scroll", schedule, { passive: true })
    measure()
    return () => {
      if (pending) cancelAnimationFrame(pending)
      observer?.disconnect()
      window.removeEventListener("resize", schedule)
      window.removeEventListener("resizable-change", schedule)
      scroller.removeEventListener("scroll", schedule)
    }
  }, [heroRef, scrollerRef, src, route])
  return null
}
