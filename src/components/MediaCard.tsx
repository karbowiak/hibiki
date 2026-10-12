import { ArtworkImage, useArtworkFailures } from "./shared/ArtworkImage"
import { Link } from "wouter"
import clsx from "clsx"
import { useTrackDrag } from "../hooks/useTrackDrag"
import { useArtistImage, useAlbumImage } from "../hooks/useMediaImage"
import type { DragPayload } from "../stores/dragStore"

interface MediaCardProps {
  title: string
  desc: string
  thumb: string | null
  /** Fallback image URL shown when `thumb` is null (e.g. an image:// cached external URL). */
  thumbFallback?: string | null
  onImageFailure?: (url: string) => void
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
  /** When provided, enables dragging this card to playlists/queue. */
  dragPayload?: DragPayload
  /** Artist name — enables priority-aware image resolution from external sources. */
  artistName?: string | null
  /** Album name — enables priority-aware album image resolution (requires artistName too). */
  albumName?: string | null
}

/**
 * Resolves the best image for an artist card via the priority metadata system.
 * Separate component to satisfy React's rules of hooks.
 */
function ArtistImageCard({ artistName, thumb, ...rest }: MediaCardProps & { artistName: string }) {
  const { failures, onFailure } = useArtworkFailures(JSON.stringify([artistName, thumb]))
  const resolved = useArtistImage(artistName, thumb, undefined, failures)
  return <MediaCardInner {...rest} thumb={resolved} onImageFailure={onFailure} />
}

/**
 * Resolves the best image for an album card via the priority metadata system.
 * Separate component to satisfy React's rules of hooks.
 */
function AlbumImageCard({ artistName, albumName, thumb, ...rest }: MediaCardProps & { artistName: string; albumName: string }) {
  const { failures, onFailure } = useArtworkFailures(JSON.stringify([artistName, albumName, thumb]))
  const resolved = useAlbumImage(artistName, albumName, thumb, undefined, failures)
  return <MediaCardInner {...rest} thumb={resolved} onImageFailure={onFailure} />
}

export function MediaCard(props: MediaCardProps) {
  const { artistName, albumName } = props
  // When artistName is provided, use priority-aware image resolution
  if (artistName) {
    if (props.isArtist) {
      return <ArtistImageCard {...props} artistName={artistName} />
    }
    if (albumName) {
      return <AlbumImageCard {...props} artistName={artistName} albumName={albumName} />
    }
  }
  return <MediaCardInner {...props} />
}

function MediaCardInner({ title, desc, thumb, thumbFallback, scrollItem, large, href, onClick, prefetch, onPlay, onContextMenu, dragPayload, onImageFailure }: MediaCardProps) {
  const displayThumb = thumb || thumbFallback || null
  const trackDrag = useTrackDrag()
  const scrollStyle = scrollItem
    ? { width: large ? "calc(var(--card-size, 160px) * 1.33)" : "var(--card-size, 160px)" }
    : undefined

  const dragHandlers = dragPayload ? {
    onPointerDown: (e: React.PointerEvent) => trackDrag.onPointerDown(e, dragPayload),
    onPointerMove: trackDrag.onPointerMove,
    onPointerUp: trackDrag.onPointerUp,
  } : undefined

  const cardContent = (
    <>
      <div className="relative mb-2">
        {displayThumb ? (
          <ArtworkImage
            onFailure={onImageFailure}
            src={displayThumb}
            alt={title}
            draggable={false}
            loading="lazy"
            className="aspect-square w-full rounded-lg object-cover"
          />
        ) : (
          <div
            className="aspect-square w-full rounded-lg bg-app-surface"
          />
        )}
        {onPlay && (
          <div className="absolute inset-0 flex items-end justify-end p-2 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 focus-within:opacity-100 focus-within:translate-y-0 transition-all duration-200">
            <button
              onClick={e => { e.preventDefault(); e.stopPropagation(); onPlay(e) }}
              aria-label={`Play ${title}`}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-black shadow-lg hover:scale-105 hover:brightness-110 active:scale-95 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none transition-all"
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
    </>
  )

  const cardClass = clsx(
    "group cursor-pointer rounded-md bg-app-card p-3 transition-colors hover:bg-hl-card",
    scrollItem && "flex-shrink-0"
  )

  if (href) {
    return (
      <Link
        href={href}
        draggable={false}
        style={scrollStyle}
        onMouseEnter={prefetch}
        onContextMenu={onContextMenu}
        className={clsx("no-underline hover:no-underline", scrollItem && "flex-shrink-0")}
        {...dragHandlers}
      >
        <div className={cardClass}>
          {cardContent}
        </div>
      </Link>
    )
  }

  if (onClick) {
    return (
      <div
        onClick={onClick}
        onMouseEnter={prefetch}
        onContextMenu={onContextMenu}
        style={scrollStyle}
        className={clsx(scrollItem && "flex-shrink-0")}
        {...dragHandlers}
      >
        <div className={cardClass}>
          {cardContent}
        </div>
      </div>
    )
  }

  return (
    <div
      onMouseEnter={prefetch}
      onContextMenu={onContextMenu}
      style={scrollStyle}
      className={cardClass}
      {...dragHandlers}
    >
      {cardContent}
    </div>
  )
}
