import type { ReactNode, RefObject } from "react"
import { ArtworkImage } from "./ArtworkImage"
import "../../styles/media-detail-controls.css"

/** Shared geometry for Plex, YouTube Music and locally managed playlists. */
export function PlaylistHero({
  heroRef,
  artwork,
  title,
  description,
  byline,
  children,
}: {
  heroRef: RefObject<HTMLDivElement | null>
  artwork: string | null
  title: string
  description?: ReactNode
  byline?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      ref={heroRef}
      className="media-detail-hero hero-overlay relative flex items-end"
    >
      <div className="relative z-10 flex w-full flex-wrap items-end gap-5">
        {artwork ? (
          <ArtworkImage
            loading="eager"
            src={artwork}
            alt=""
            className="h-44 w-44 shrink-0 rounded-lg object-cover shadow-xl"
          />
        ) : (
          <div className="bg-app-surface h-44 w-44 shrink-0 rounded-lg shadow-xl" />
        )}
        <div className="flex min-h-44 min-w-0 flex-[1_1_16rem] flex-col justify-between gap-4">
          <div className="min-w-0">
            <h1 className="media-detail-title wrap-break-word">{title}</h1>
            {byline}
            {description}
          </div>
          <div className="relative z-20 flex flex-wrap items-center gap-3">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
