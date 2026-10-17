import { useCallback, useState } from "react"

const waiting = new Map<Element, () => void>()
let observer: IntersectionObserver | undefined

/** One observer for all cards, released after their first nearby appearance. */
export function useNearViewport() {
  const [near, setNear] = useState(false)
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    if (typeof IntersectionObserver === "undefined") {
      setNear(true)
      return
    }
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          waiting.get(entry.target)?.()
          waiting.delete(entry.target)
          observer!.unobserve(entry.target)
        }
      },
      { rootMargin: "300px" }
    )
    waiting.set(node, () => setNear(true))
    observer.observe(node)
    return () => {
      waiting.delete(node)
      observer?.unobserve(node)
    }
  }, [])
  return { near, ref }
}
