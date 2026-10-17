import { useLayoutEffect, useRef, useState, type RefObject } from "react"
import { useScrollContainer } from "../lib/scrollContainer"

/** Window rows in the page's existing scroller, without creating a nested scroll area. */
export function useVirtualWindow(
  count: number,
  estimate = 56,
  columns = 1,
  enabled = true,
  scrollOverride?: RefObject<HTMLDivElement | null>
) {
  enabled = enabled && typeof ResizeObserver !== "undefined"
  const host = useRef<HTMLElement>(null)
  const measure = useRef<HTMLElement>(null)
  const inherited = useScrollContainer()
  const page = scrollOverride ?? inherited
  const [view, setView] = useState({ start: 0, end: 30, size: estimate })
  const rows = Math.ceil(count / columns)
  useLayoutEffect(() => {
    if (!enabled || !host.current) return
    const element = host.current
    const scroller =
      page?.current ??
      element.closest<HTMLElement>("[data-virtual-scroll], .app-page-content")
    const target = scroller ?? window
    let frame = 0
    const update = () => {
      frame = 0
      const size = measure.current?.getBoundingClientRect().height || estimate
      const bounds = element.getBoundingClientRect()
      const top = scroller?.getBoundingClientRect().top ?? 0
      const height = scroller?.clientHeight || window.innerHeight
      const first = Math.max(0, Math.floor((top - bounds.top) / size) - 6)
      const start = Math.min(Math.max(0, rows - 1), first)
      const end = Math.min(
        rows,
        Math.max(start + 1, Math.ceil((top + height - bounds.top) / size) + 6)
      )
      setView((previous) =>
        previous.start === start &&
        previous.end === end &&
        previous.size === size
          ? previous
          : { start, end, size }
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    target.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule)
    observer?.observe(element)
    if (scroller) observer?.observe(scroller)
    if (measure.current) observer?.observe(measure.current)
    update()
    return () => {
      target.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      observer?.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [count, estimate, columns, enabled, page, rows])
  return {
    host,
    measure,
    start: enabled ? view.start * columns : 0,
    end: enabled ? Math.min(count, view.end * columns) : count,
    before: enabled ? view.start * view.size : 0,
    after: enabled ? Math.max(0, rows - view.end) * view.size : 0,
  }
}

export function virtualRef<T extends HTMLElement>(
  ref: RefObject<HTMLElement | null>
) {
  return ref as RefObject<T | null>
}
