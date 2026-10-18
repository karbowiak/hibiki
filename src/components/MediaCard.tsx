import { Button } from "./shared/Button"
import { ArtistCreditLinks } from "./shared/ArtistCredits"
import { itemArtistCredits } from "../lib/artistCredits"
import { useCallback, useEffect, useRef, useState } from "react"
import { makeOnPlay } from "../lib/mediaPlay"
import { usePlayerStore } from "../stores/playerStore"
import { DownloadBadge } from "./shared/DownloadBadge"
import { useProviderStore } from "../stores/providerStore"
import {
  useContextMenuStore,
  type ContextAction,
} from "../stores/contextMenuStore"
import { ArtworkImage, useArtworkFailures } from "./shared/ArtworkImage"
import { Link } from "wouter"
import clsx from "clsx"
import { IconStar } from "@tabler/icons-react"
import { starsFromRating } from "../lib/formatters"
import { useTrackDrag } from "../hooks/useTrackDrag"
import { useArtistImage, useAlbumImage } from "../hooks/useMediaImage"
import { useContextMenu } from "../hooks/useContextMenu"
import type { MusicItem, MusicArtistCredit } from "../types/music"
import type { DragPayload } from "../stores/dragStore"
import { useNearViewport } from "../hooks/useNearViewport"
import type { Ref, ReactNode } from "react"
import { MusicEntityLink } from "./shared/MusicEntityLink"
import { albumArtistEntity, trackEntity, type MusicEntityRef } from "../lib/musicLinks"

interface MediaCardProps {
  navigationEntity?: MusicEntityRef | null
  descriptionEntity?: MusicEntityRef | null
  descriptionArtists?: { name: string; credits: MusicArtistCredit[] }
  artworkBadge?: ReactNode
  artworkRef?: Ref<HTMLDivElement>
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
  /** Actual provider media only; synthetic stations and public feeds omit it. */
  contextItem?: MusicItem
  /** Ephemeral actions for generated mixes/stations, without library IDs. */
  contextActions?: readonly ContextAction[]
  /** When provided, enables dragging this card to playlists/queue. */
  dragPayload?: DragPayload
  /** Artist name — enables priority-aware image resolution from external sources. */
  artistName?: string | null
  /** Album name — enables priority-aware album image resolution (requires artistName too). */
  albumName?: string | null
  versionCount?: number
  userRating?: number | null
  onViewVersions?: () => void
}

interface CardArtwork {
  identity: string
  url: string | null
}
function useCardArtwork(identity: string, fallback: string | null) {
  const [resolved, setResolved] = useState<CardArtwork | null>(null)
  const publish = useCallback(
    (value: CardArtwork) =>
      setResolved((previous) =>
        previous?.identity === value.identity && previous.url === value.url
          ? previous
          : value
      ),
    []
  )
  return {
    url: resolved?.identity === identity ? resolved.url : fallback,
    publish,
  }
}
interface ArtworkResolverProps {
  identity: string
  artist: string
  thumb: string | null
  failures: readonly string[]
  publish: (value: CardArtwork) => void
}
function ArtistArtworkResolver({
  identity,
  artist,
  thumb,
  failures,
  publish,
}: ArtworkResolverProps) {
  const url = useArtistImage(artist, thumb, undefined, failures, true)
  useEffect(() => publish({ identity, url }), [identity, url, publish])
  return null
}
function AlbumArtworkResolver({
  identity,
  artist,
  album,
  thumb,
  failures,
  publish,
}: ArtworkResolverProps & { album: string }) {
  const url = useAlbumImage(artist, album, thumb, undefined, failures, true)
  useEffect(() => publish({ identity, url }), [identity, url, publish])
  return null
}

/** Offscreen cards keep their own focus/DOM while expensive artwork hooks wait. */
function ArtistImageCard({
  artistName,
  thumb,
  ...rest
}: MediaCardProps & { artistName: string }) {
  const { near, ref } = useNearViewport()
  const identity = JSON.stringify([artistName, thumb])
  const { failures, onFailure } = useArtworkFailures(identity)
  const { url, publish } = useCardArtwork(identity, thumb)
  return (
    <>
      <MediaCardInner
        {...rest}
        artistName={artistName}
        artworkRef={ref}
        thumb={url}
        onImageFailure={onFailure}
      />
      {near && (
        <ArtistArtworkResolver
          identity={identity}
          artist={artistName}
          thumb={thumb}
          failures={failures}
          publish={publish}
        />
      )}
    </>
  )
}
function AlbumImageCard({
  artistName,
  albumName,
  thumb,
  ...rest
}: MediaCardProps & { artistName: string; albumName: string }) {
  const { near, ref } = useNearViewport()
  const identity = JSON.stringify([artistName, albumName, thumb])
  const { failures, onFailure } = useArtworkFailures(identity)
  const { url, publish } = useCardArtwork(identity, thumb)
  return (
    <>
      <MediaCardInner
        {...rest}
        artistName={artistName}
        artworkRef={ref}
        thumb={url}
        onImageFailure={onFailure}
      />
      {near && (
        <AlbumArtworkResolver
          identity={identity}
          artist={artistName}
          album={albumName}
          thumb={thumb}
          failures={failures}
          publish={publish}
        />
      )}
    </>
  )
}

export function MediaCard(props: MediaCardProps) {
  const { artistName, albumName } = props
  // When artistName is provided, use priority-aware image resolution
  if (artistName) {
    if (props.isArtist) {
      return <ArtistImageCard {...props} artistName={artistName} />
    }
    if (albumName) {
      return (
        <AlbumImageCard
          {...props}
          artistName={artistName}
          albumName={albumName}
        />
      )
    }
  }
  return <MediaCardInner {...props} />
}

function MediaCardInner({
  navigationEntity,
  descriptionEntity,
  descriptionArtists,
  artistName,
  isArtist,
  artworkBadge,
  artworkRef,
  title,
  desc,
  thumb,
  thumbFallback,
  scrollItem,
  large,
  href,
  onClick,
  prefetch,
  onPlay,
  onContextMenu,
  dragPayload,
  onImageFailure,
  contextItem,
  contextActions,
  versionCount,
  userRating,
  onViewVersions,
}: MediaCardProps) {
  const { handler, actionsHandler } = useContextMenu()
  const offline = useProviderStore((state) => state.provider?.isOffline)
  const unavailable =
    !!offline &&
    !!contextItem &&
    (contextItem.type === "track"
      ? contextItem.mediaInfo?.offlineAvailable !== true
      : contextItem.offlineAvailable !== true)
  const menuOwner = useRef({})
  useEffect(
    () => () => {
      const menu = useContextMenuStore.getState()
      if (
        menu.type === "actions" &&
        menu.data &&
        "owner" in menu.data &&
        menu.data.owner === menuOwner.current
      )
        menu.close()
    },
    [title, href]
  )
  const contextHandler =
    onContextMenu ??
    (contextItem
      ? handler(contextItem.type, contextItem)
      : contextActions?.length
        ? actionsHandler({
            title,
            owner: menuOwner.current,
            actions: contextActions,
          })
        : undefined)
  const displayThumb = thumb || thumbFallback || null
  const trackDrag = useTrackDrag()
  const scrollStyle = scrollItem
    ? {
        width: large
          ? "calc(var(--card-size, 160px) * 1.33)"
          : "var(--card-size, 160px)",
      }
    : undefined

  const dragHandlers = dragPayload
    ? {
        onPointerDown: (e: React.PointerEvent) =>
          trackDrag.onPointerDown(e, dragPayload),
        onPointerMove: trackDrag.onPointerMove,
        onPointerUp: trackDrag.onPointerUp,
      }
    : undefined

  const initials = title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toLocaleUpperCase()
  const credit = descriptionEntity !== undefined ? descriptionEntity : contextItem?.type === "album" ? albumArtistEntity(contextItem)
    : contextItem?.type === "track" ? trackEntity(contextItem, "artist") : !isArtist && artistName ? { kind: "artist" as const, name: artistName } : null
  const cardContent = (
    <>
      <div className="media-card__art aspect-square">
        <div className="media-card__fallback" aria-hidden="true">
          <span>{initials}</span>
        </div>
        {displayThumb && (
          <ArtworkImage
            onFailure={onImageFailure}
            src={displayThumb}
            alt={title}
            draggable={false}
            loading="lazy"
            className="media-card__image"
          />
        )}
      </div>
      <div className="media-card__gradient" aria-hidden="true" />
      {artworkBadge && <span className="absolute top-2 right-2 z-10 flex h-7 min-w-7 items-center justify-center rounded-full bg-black/70 p-1.5 pointer-events-none">{artworkBadge}</span>}
      {onViewVersions && (versionCount ?? 0) > 1 && (
        <Button
          variant="bare"
          type="button"
          className="media-card__versions"
          aria-label={`Compare ${versionCount} versions of ${title}`}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onViewVersions()
          }}
        >
          {versionCount} versions
        </Button>
      )}
      <div
        className={clsx(
          "media-card__caption",
          credit && "media-card__caption--links",
          onPlay && "media-card__caption--play"
        )}
      >
        <div className="media-card__title" title={title}>
          {title}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="media-card__meta min-w-0" title={desc}>
            {descriptionArtists && desc.startsWith(descriptionArtists.name) ? <>
              <ArtistCreditLinks credits={descriptionArtists.credits} className="relative z-4 pointer-events-auto hover:underline" />
              {desc.slice(descriptionArtists.name.length)}
            </> : contextItem && (contextItem.type === "track" || contextItem.type === "album") && desc.startsWith(contextItem.artistName) ? <>
              <ArtistCreditLinks credits={itemArtistCredits(contextItem)} className="relative z-4 pointer-events-auto hover:underline" />
              {desc.slice(contextItem.artistName.length)}
            </> : credit ? <MusicEntityLink entity={credit} className="relative z-4 pointer-events-auto hover:underline">{desc}</MusicEntityLink> : desc}
          </div>
          {contextItem && (
            <DownloadBadge
              kind={contextItem.type}
              id={contextItem.id}
              className="!text-white"
            />
          )}
        </div>
        {!!userRating && starsFromRating(userRating) > 0 && (
          <span
            className="media-card__rating"
            role="img"
            aria-label={`Rated ${starsFromRating(userRating)} of 5 stars`}
          >
            {Array.from({ length: 5 }, (_, index) => (
              <IconStar
                key={index}
                size={11}
                aria-hidden="true"
                fill={
                  index < starsFromRating(userRating) ? "currentColor" : "none"
                }
              />
            ))}
          </span>
        )}
      </div>
      {onPlay && (
        <Button
          variant="bare"
          type="button"
          disabled={unavailable}
          title={
            unavailable
              ? "Download this music while connected to play offline"
              : undefined
          }
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (unavailable) return
            if (offline && contextItem) {
              makeOnPlay(contextItem, {
                ...usePlayerStore.getState(),
                provider: useProviderStore.getState().provider,
              })?.()
            } else onPlay(e)
          }}
          aria-label={`Play ${title}`}
          className="media-card__play"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="currentColor"
          >
            <polygon points="3,2 13,8 3,14" />
          </svg>
        </Button>
      )}
    </>
  )

  const cardClass = clsx(
    "media-card group",
    scrollItem && "shrink-0",
    unavailable && "media-card--unavailable"
  )
  const primaryClass = "media-card__primary"
  return (
    <div
      ref={artworkRef}
      style={scrollStyle}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      onContextMenu={contextHandler}
      onKeyDown={
        contextHandler
          ? (e) => {
              if (
                e.repeat ||
                e.nativeEvent.isComposing ||
                e.altKey ||
                e.ctrlKey ||
                e.metaKey
              )
                return
              if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey))
                return
              e.preventDefault()
              e.stopPropagation()
              const bounds = e.currentTarget.getBoundingClientRect()
              e.currentTarget.dispatchEvent(
                new window.MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  clientX: bounds.left,
                  clientY: bounds.bottom,
                })
              )
            }
          : undefined
      }
      className={cardClass}
      {...(!href && !onClick ? dragHandlers : undefined)}
    >
      {navigationEntity ? (
        <MusicEntityLink entity={navigationEntity} className={primaryClass} onNavigate={onClick}>
          <span className="sr-only">{title}</span>
        </MusicEntityLink>
      ) : href ? (
        <Link
          href={href}
          onClick={onClick}
          aria-label={title}
          draggable={false}
          className={primaryClass}
          {...dragHandlers}
        />
      ) : onClick ? (
        <Button
          variant="bare"
          type="button"
          onClick={onClick}
          aria-label={title}
          className={primaryClass}
          {...dragHandlers}
        />
      ) : null}
      {cardContent}
    </div>
  )
}
