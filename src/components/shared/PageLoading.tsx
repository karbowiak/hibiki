import { useRef } from "react"
import { AmbientHeroBackdrop } from "./MediaBackdrop"
import { MediaGrid } from "./MediaGrid"
import { MediaCardSkeleton, MediaShelfSkeleton, Skeleton } from "./Skeleton"
import "../../styles/detailMedia.css"
import "../../styles/media-detail-controls.css"
import "../../styles/discovery.css"
import "../../styles/broadcast.css"

type Props = {
  message: string
  variant?:
    | "detail"
    | "artist"
    | "album"
    | "playlist"
    | "tracks"
    | "podcast"
    | "home"
    | "shelves"
    | "grid"
}

function LoadingRows({ artwork = false }: { artwork?: boolean }) {
  return (
    <div className="skeleton-track-list">
      {Array.from({ length: 6 }, (_, i) => (
        <div className="skeleton-track-row" key={i}>
          <Skeleton
            className={artwork ? "skeleton-track-art" : "skeleton-track-number"}
          />
          <div className="skeleton-track-info">
            <Skeleton
              className="skeleton-track-title"
              style={{ width: String(45 + (i % 3) * 12) + "%" }}
            />
            <Skeleton className="skeleton-track-meta" />
          </div>
          <Skeleton className="skeleton-track-duration" />
        </div>
      ))}
    </div>
  )
}

/** Reserve the real hero, ledger and tile shapes while the first request loads. */
export function PageLoading({ message, variant = "detail" }: Props) {
  const heroRef = useRef<HTMLDivElement>(null)
  const detail = ["detail", "artist", "album", "playlist"].includes(variant)
  const kind = variant === "detail" ? "album" : variant
  return (
    <div
      data-page-loading={kind}
      className={
        "page-loading " +
        (detail
          ? "media-detail-page " +
            (kind === "playlist" ? "playlist-detail-page" : "")
          : kind === "podcast"
            ? "broadcast-detail"
            : "")
      }
    >
      <span role="status" className="sr-only">
        {message}
      </span>
      {detail ? (
        <>
          <AmbientHeroBackdrop heroRef={heroRef} />
          <div
            ref={heroRef}
            aria-hidden="true"
            className="media-detail-hero hero-overlay skeleton-detail-hero"
          >
            <div
              className={
                "skeleton-detail-content skeleton-detail-content--" + kind
              }
            >
              <Skeleton
                className={
                  "skeleton-detail-cover skeleton-detail-cover--" + kind
                }
              />
              <div className="skeleton-detail-info">
                <Skeleton className="skeleton-detail-eyebrow" />
                <Skeleton className="skeleton-detail-title" />
                <Skeleton className="skeleton-detail-meta" />
                {kind !== "playlist" && (
                  <Skeleton className="skeleton-detail-meta skeleton-detail-meta--short" />
                )}
                <div className="skeleton-detail-actions">
                  <Skeleton className="skeleton-action" />
                  <Skeleton className="skeleton-action" />
                  <Skeleton className="skeleton-action" />
                </div>
              </div>
            </div>
          </div>
          <div aria-hidden="true" className="media-ledger skeleton-ledger">
            {Array.from({ length: kind === "album" ? 4 : 2 }, (_, i) => (
              <div key={i}>
                <Skeleton className="skeleton-ledger-label" />
                <Skeleton className="skeleton-ledger-value" />
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="skeleton-detail-body">
            <Skeleton className="skeleton-section-title" />
            <LoadingRows artwork={kind === "playlist"} />
            {kind === "artist" && <MediaShelfSkeleton />}
          </div>
        </>
      ) : kind === "tracks" ? (
        <div aria-hidden="true"><LoadingRows artwork /></div>
      ) : kind === "podcast" ? (
        <div aria-hidden="true">
          <div className="broadcast-detail__hero">
            <Skeleton className="broadcast-detail__cover" />
            <div className="broadcast-detail__info skeleton-podcast-info">
              <Skeleton className="skeleton-detail-eyebrow" />
              <Skeleton className="skeleton-detail-title" />
              <Skeleton className="skeleton-detail-meta" />
              <Skeleton className="skeleton-detail-meta" />
              <div className="skeleton-detail-actions">
                <Skeleton className="skeleton-action skeleton-action--round" />
                <Skeleton className="skeleton-action" />
              </div>
              <Skeleton className="skeleton-detail-meta skeleton-detail-meta--short" />
            </div>
          </div>
          <div className="broadcast-episodes">
            <Skeleton className="skeleton-section-title" />
            <LoadingRows artwork />
          </div>
        </div>
      ) : kind === "grid" ? (
        <MediaGrid>
          {Array.from({ length: 12 }, (_, i) => (
            <MediaCardSkeleton key={i} />
          ))}
        </MediaGrid>
      ) : (
        <div aria-hidden="true" className="skeleton-browse">
          {kind === "home" && (
            <header className="discovery-head">
              <div className="skeleton-home-info">
                <Skeleton className="skeleton-detail-eyebrow" />
                <Skeleton className="skeleton-home-title" />
                <Skeleton className="skeleton-home-subtitle" />
              </div>
              <div className="discovery-tools">
                <Skeleton className="skeleton-action" />
                <Skeleton className="skeleton-action" />
              </div>
            </header>
          )}
          <MediaShelfSkeleton large={kind === "home"} />
          <MediaShelfSkeleton />
          <MediaShelfSkeleton />
        </div>
      )}
    </div>
  )
}
