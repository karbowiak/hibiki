import { useState, useEffect } from "react"
import { Link } from "wouter"
import { useScrollRestore } from "../hooks/useScrollRestore"

interface ScrollRowProps {
  title: string
  titleHref?: string
  children: React.ReactNode
  restoreKey?: string
  onPlayAll?: () => void
  onShuffleAll?: () => void
}

export function ScrollRow({ title, titleHref, children, restoreKey, onPlayAll, onShuffleAll }: ScrollRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const scrollRef = useScrollRestore(restoreKey, "x")

  useEffect(() => {
    if (expanded) return
    const el = scrollRef.current
    if (!el) return

    const check = () => setOverflows(el.scrollWidth > el.clientWidth)
    check()

    const ro = new ResizeObserver(check)
    ro.observe(el)

    // Re-check when children are added/removed (e.g. lazy-loaded stations)
    const mo = new MutationObserver(check)
    mo.observe(el, { childList: true, subtree: true })

    return () => { ro.disconnect(); mo.disconnect() }
  }, [expanded, scrollRef])

  const scroll = (dir: "left" | "right") => {
    scrollRef.current?.scrollBy({ left: dir === "left" ? -440 : 440, behavior: "smooth" })
  }

  const showButtons = expanded || overflows

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        {titleHref ? (
          <h2 className="min-w-0 text-xl font-bold">
            <Link
              href={titleHref}
              className="hover:underline decoration-white/40 underline-offset-4 flex items-center gap-2 group"
            >
              <span className="truncate">{title}</span>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"
                   className="text-white/30 group-hover:text-white/60 transition-colors flex-shrink-0">
                <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/>
              </svg>
            </Link>
          </h2>
        ) : (
          <h2 className="min-w-0 truncate text-xl font-bold">{title}</h2>
        )}
        {onPlayAll && (
          <button
            onClick={onPlayAll}
            aria-label="Play all"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent/70 transition-all hover:bg-accent/30 hover:text-accent active:scale-95"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>
        )}
        {onShuffleAll && (
          <button
            onClick={onShuffleAll}
            aria-label="Shuffle all"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent/20 text-accent/70 transition-all hover:bg-accent/30 hover:text-accent active:scale-95"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 3 21 3 21 8"/>
              <line x1="4" y1="20" x2="21" y2="3"/>
              <polyline points="21 16 21 21 16 21"/>
              <line x1="15" y1="15" x2="21" y2="21"/>
              <line x1="4" y1="4" x2="9" y2="9"/>
            </svg>
          </button>
        )}
        <div className="grow" />
        {!expanded && overflows && (
          <>
            <button
              onClick={() => scroll("left")}
              aria-label="Scroll left"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-app-surface text-white/70 transition-colors hover:bg-hl-card hover:text-white active:scale-95"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button
              onClick={() => scroll("right")}
              aria-label="Scroll right"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-app-surface text-white/70 transition-colors hover:bg-hl-card hover:text-white active:scale-95"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </>
        )}
        {showButtons && (
          <button
            onClick={() => setExpanded(e => !e)}
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
            className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors active:scale-95 ${expanded ? "bg-accent/20 text-accent" : "bg-app-surface text-white/70 hover:bg-hl-card hover:text-white"}`}
          >
            <svg
              viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>
      {expanded ? (
        <div
          className="scroll-row-grid grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(var(--card-size, 160px), 1fr))" }}
        >
          {children}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          {children}
        </div>
      )}
    </div>
  )
}
