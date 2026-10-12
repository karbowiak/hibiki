import type { CSSProperties } from "react"
import "../../styles/loading.css"
import "../../styles/media.css"

/** Decorative placeholders never masquerade as usable controls. */
export function Skeleton({
  className = "",
  style,
}: {
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      aria-hidden="true"
      className={`skeleton-block skeleton-shimmer ${className}`}
      style={style}
    />
  )
}

export function MediaCardSkeleton({
  scrollItem,
  large,
}: {
  scrollItem?: boolean
  large?: boolean
}) {
  return (
    <div
      aria-hidden="true"
      className="media-card media-card-skeleton skeleton-block skeleton-shimmer"
      style={
        scrollItem
          ? {
              width: large
                ? "calc(var(--card-size, 160px) * 1.33)"
                : "var(--card-size, 160px)",
              flexShrink: 0,
            }
          : undefined
      }
    >
      <div className="media-card__gradient" />
      <div className="media-card__caption">
        <div className="skeleton-block skeleton-card-title" />
        <div className="skeleton-block skeleton-card-meta" />
      </div>
    </div>
  )
}

export function MediaShelfSkeleton({
  title,
  large,
  count = 12,
}: {
  title?: string
  large?: boolean
  count?: number
}) {
  return (
    <section aria-hidden="true" className="media-row skeleton-shelf">
      <div className="media-row__header">
        {title ? (
          <h2 className="media-row__heading">{title}</h2>
        ) : (
          <Skeleton className="skeleton-shelf-title" />
        )}
        <div className="media-row__rule" />
        <div className="skeleton-shelf-controls">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="skeleton-shelf-control" />
          ))}
        </div>
      </div>
      <div className="skeleton-shelf-rail">
        {Array.from({ length: count }, (_, i) => (
          <MediaCardSkeleton key={i} scrollItem large={large} />
        ))}
      </div>
    </section>
  )
}
