import { useScrollRestore } from "../hooks/useScrollRestore"

interface ScrollRowProps {
  title: string
  children: React.ReactNode
  restoreKey?: string
}

export function ScrollRow({ title, children, restoreKey }: ScrollRowProps) {
  const scrollRef = useScrollRestore(restoreKey, "x")

  const scroll = (dir: "left" | "right") => {
    scrollRef.current?.scrollBy({ left: dir === "left" ? -440 : 440, behavior: "smooth" })
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="grow text-2xl font-bold">{title}</span>
        <button
          onClick={() => scroll("left")}
          aria-label="Scroll left"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-black transition-all hover:brightness-110 active:scale-95"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          onClick={() => scroll("right")}
          aria-label="Scroll right"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-black transition-all hover:brightness-110 active:scale-95"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
      <div
        ref={scrollRef}
        className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
    </div>
  )
}
