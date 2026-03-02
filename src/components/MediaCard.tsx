import { Link } from "wouter"
import clsx from "clsx"

interface MediaCardProps {
  title: string
  desc: string
  thumb: string | null
  /** Fallback image URL shown when `thumb` is null (e.g. a metaimg:// cached external URL). */
  thumbFallback?: string | null
  isArtist?: boolean
  /** When true, fixes card at 160px wide and prevents flex shrink (for scroll rows) */
  scrollItem?: boolean
  /** When true (with scrollItem), renders card ~33% larger at 213px */
  large?: boolean
  href?: string
  onClick?: () => void
  /** Called once on first hover — used for eager pre-fetching of page data. */
  prefetch?: () => void
  /** When provided, shows a play button overlay on hover. Called on click. */
  onPlay?: (e: React.MouseEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
}

export function MediaCard({ title, desc, thumb, thumbFallback, isArtist, scrollItem, large, href, onClick, prefetch, onPlay, onContextMenu }: MediaCardProps) {
  const displayThumb = thumb || thumbFallback || null
  const scrollStyle = scrollItem
    ? { width: large ? "calc(var(--card-size, 160px) * 1.33)" : "var(--card-size, 160px)" }
    : undefined
  const inner = (
    <div
      onMouseEnter={prefetch}
      onContextMenu={onContextMenu}
      style={scrollStyle}
      className={clsx(
        "group cursor-pointer rounded-md bg-app-card p-3 transition-colors hover:bg-app-surface-hover",
        scrollItem && "flex-shrink-0"
      )}
    >
      <div className="relative mb-3">
        {displayThumb ? (
          <img
            src={displayThumb}
            alt={title}
            draggable={false}
            loading="lazy"
            className={
              isArtist
                ? "aspect-square w-full rounded-full object-cover"
                : "aspect-square w-full rounded-md object-cover"
            }
          />
        ) : (
          <div
            className={
              isArtist
                ? "aspect-square w-full rounded-full bg-app-surface"
                : "aspect-square w-full rounded-md bg-app-surface"
            }
          />
        )}
        {onPlay && (
          <div className="absolute inset-0 flex items-end justify-end p-2 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200">
            <button
              onClick={e => { e.preventDefault(); e.stopPropagation(); onPlay(e) }}
              aria-label={`Play ${title}`}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-black shadow-lg hover:scale-105 hover:brightness-110 active:scale-95 transition-all"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                <polygon points="3,2 13,8 3,14" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <div className="truncate text-sm font-semibold text-white">{title}</div>
      <div className="mt-1 truncate text-xs text-neutral-400">{desc}</div>
    </div>
  )

  if (href) {
    return (
      <Link href={href} style={scrollStyle} onContextMenu={onContextMenu} className={clsx("no-underline hover:no-underline", scrollItem && "flex-shrink-0")}>
        {inner}
      </Link>
    )
  }

  if (onClick) {
    return <div onClick={onClick} onContextMenu={onContextMenu} style={scrollStyle} className={clsx(scrollItem && "flex-shrink-0")}>{inner}</div>
  }

  return inner
}
