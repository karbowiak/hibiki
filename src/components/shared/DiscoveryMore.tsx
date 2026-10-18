import { Button } from "./Button"
import { useEffect, useRef } from "react"
import { useScrollContainer } from "../../lib/scrollContainer"

export function DiscoveryMore({ more, loading, error, load }: { more: boolean; loading: boolean; error: boolean; load: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null)
  const root = useScrollContainer()
  useEffect(() => {
    if (!more || loading || error || !sentinel.current) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load() },
      { root: root?.current, rootMargin: "400px" })
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [more, loading, error, load, root])
  if (!more && !loading && !error) return null
  return (
    <div ref={sentinel} className="flex flex-col items-center gap-3 py-6">
      {error && <p role="alert" className="text-sm text-(--text-secondary)">Could not load more music. Your loaded items are still available.</p>}
      <Button variant="bare" type="button" disabled={loading} onClick={load}
        className="rounded-full border border-(--border) bg-app-surface px-5 py-2 text-sm text-(--text-primary) hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
        {loading ? "Loading…" : error ? "Try again" : "Load more"}
      </Button>
    </div>
  )
}
