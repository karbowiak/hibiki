import { Button } from "./Button"
import { useEffect, useRef, useState } from "react"
import { useContextMenu } from "../../hooks/useContextMenu"
import { useContextMenuStore, type ContextActionsData } from "../../stores/contextMenuStore"
import { ArtworkImage } from "./ArtworkImage"
import "../../styles/broadcast.css"
interface Props {
  title: string
  description: string
  src: string | null
  openLabel: string
  intent?: "open" | "play"
  onOpen: () => void
  scrollItem?: boolean
  active?: boolean
  live?: boolean
  error?: string
  favorite?: boolean
  onFavorite?: () => void
}
/** Artwork-led audio tile with independent keyboard actions and no nested buttons. */
export function AudioBrowseCard({
  title,
  description,
  src,
  openLabel,
  intent = "open",
  onOpen,
  scrollItem,
  active,
  live,
  error,
  favorite,
  onFavorite,
}: Props) {
  const [failed, setFailed] = useState<string | null>(null)
  const owner = useRef<object>({})
  const { actionsHandler } = useContextMenu()
  const actions: ContextActionsData = {
    title, owner: owner.current,
    actions: [
      { label: openLabel, run: onOpen },
      ...(onFavorite ? [{ label: favorite ? "Remove from favorites" : "Add to favorites", run: onFavorite }] : []),
    ],
  }
  useEffect(() => () => {
    const menu = useContextMenuStore.getState()
    if (menu.type === "actions" && (menu.data as ContextActionsData)?.owner === owner.current) menu.close()
  }, [title, src, openLabel, favorite])
  return (
    <article
      onContextMenu={actionsHandler(actions)}
      onKeyDown={e => {
        if (e.repeat || e.nativeEvent.isComposing || e.ctrlKey || e.altKey || e.metaKey) return
        if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return
        e.preventDefault(); e.stopPropagation()
        const bounds = e.currentTarget.getBoundingClientRect()
        e.currentTarget.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: bounds.left, clientY: bounds.bottom }))
      }}
      className={`media-card broadcast-card${active ? "broadcast-card--active" : ""}`}
      style={
        scrollItem
          ? { width: "var(--card-size, 160px)", flexShrink: 0 }
          : undefined
      }
    >
      <div className="media-card__art">
        {src && failed !== src ? (
          <ArtworkImage
            src={src}
            onFailure={() => setFailed(src)}
            alt=""
            loading="lazy"
            className="media-card__image"
          />
        ) : (
          <div className="media-card__fallback">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="44"
              height="44"
              fill="currentColor"
            >
              <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm-5 9H5a7 7 0 0 0 6 6.93V21h2v-3.07A7 7 0 0 0 19 11h-2a5 5 0 0 1-10 0z" />
            </svg>
          </div>
        )}
      </div>
      <div className="media-card__gradient" />
      <div className="media-card__caption media-card__caption--play">
        <p className="media-card__title">{title}</p>
        <p className="media-card__meta">{description}</p>
        {error && (
          <p role="alert" className="broadcast-card__error">
            {error}
          </p>
        )}
      </div>
      <Button
        variant="bare"
        type="button"
        className="media-card__primary"
        aria-label={openLabel}
        onClick={onOpen}
      />
      <span
        aria-hidden="true"
        className="media-card__play broadcast-card__play"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          {intent === "play" ? (
            <polygon points="3,2 13,8 3,14" />
          ) : (
            <path d="m6 2 6 6-6 6-1.5-1.5L9 8 4.5 3.5z" />
          )}
        </svg>
      </span>
      {live && <span className="broadcast-card__live">Live</span>}
      {onFavorite && (
        <Button
          variant="bare"
          type="button"
          aria-label={`${favorite ? "Remove from" : "Add to"} favorites: ${title}`}
          aria-pressed={favorite}
          onClick={onFavorite}
          className="broadcast-card__favorite"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill={favorite ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </Button>
      )}
    </article>
  )
}
