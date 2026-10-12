import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { refreshImage as refreshNativeImage } from "../../lib/imageCache"
import { createPortal } from "react-dom"
import {
  useArtistArtwork,
  useAlbumArtwork,
  type ArtworkResolution,
} from "../../hooks/useMediaImage"
import { useProviderStore } from "../../stores/providerStore"
import {
  artworkPreferenceKey,
  useArtworkPreferenceStore,
  type ArtworkKind,
  type ArtworkSource,
} from "../../stores/artworkPreferenceStore"
import { useDeezerMetadataStore } from "../../metadata/deezer/store"
import { useItunesMetadataStore } from "../../metadata/apple/store"
import { ArtworkImage, useArtworkFailures } from "./ArtworkImage"

const labels: Record<ArtworkSource, string> = {
  plex: "Plex",
  deezer: "Deezer",
  apple: "Apple Music",
}
export interface ArtworkSourcePickerProps {
  kind: ArtworkKind
  artistName: string
  albumName?: string | null
  plexThumb: string | null
  entityId?: string | null
  className?: string
  label?: string
  refreshImage?: (
    source: ArtworkSource,
    url: string
  ) => Promise<void | { revision: string }>
}
export function artworkStatus(info: ArtworkResolution): string {
  if (info.preference && info.source !== info.preference)
    return info.source
      ? `${labels[info.source]} fallback · ${labels[info.preference]} ${info.pending ? "is loading" : "artwork is unavailable"}`
      : `${labels[info.preference]} ${info.pending ? "is loading" : "artwork is unavailable"}`
  return info.source
    ? `${labels[info.source]} · ${info.preference ? "Selected source" : "Automatic"}`
    : "No artwork available"
}
export function ArtworkSourcePicker(props: ArtworkSourcePickerProps) {
  const provider = useProviderStore((s) => s.provider)
  const refreshImage =
    props.refreshImage ??
    (isTauri()
      ? (_source: ArtworkSource, url: string) => refreshNativeImage(url)
      : undefined)
  const key = artworkPreferenceKey(
    provider?.cacheScope,
    props.kind,
    props.artistName,
    props.albumName
  )
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([key, props.plexThumb, refresh])
  )
  const artist = useArtistArtwork(
    props.kind === "artist" ? props.artistName : null,
    props.kind === "artist" ? props.plexThumb : null,
    props.entityId,
    failures
  )
  const album = useAlbumArtwork(
    props.kind === "album" ? props.artistName : null,
    props.kind === "album" ? (props.albumName ?? null) : null,
    props.kind === "album" ? props.plexThumb : null,
    props.entityId,
    failures
  )
  const info = props.kind === "artist" ? artist : album
  const open = !!key && openFor === key
  return (
    <>
      <button
        type="button"
        disabled={!key}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true })
          setOpenFor(key)
        }}
        className={
          props.className ??
          "rounded-full border border-[var(--border)] bg-app-surface px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        }
      >
        {props.label ?? "Artwork sources"}
      </button>
      {open && key && (
        <SourceDialog
          {...props}
          refreshImage={refreshImage}
          preferenceKey={key}
          info={info}
          onFailure={onFailure}
          onRefresh={() => setRefresh((x) => x + 1)}
          onClose={() => setOpenFor(null)}
        />
      )}
    </>
  )
}
function SourceDialog({
  preferenceKey,
  info,
  onFailure,
  onRefresh,
  onClose,
  ...props
}: ArtworkSourcePickerProps & {
  preferenceKey: string
  info: ArtworkResolution
  onFailure: (url: string) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const active = useRef(true)
  const owner = useRef(useProviderStore.getState().provider)
  const ownerScope = useRef(owner.current?.cacheScope)
  const current = () =>
    active.current &&
    useProviderStore.getState().provider === owner.current &&
    owner.current?.cacheScope === ownerScope.current
  const deezerHydrated = useDeezerMetadataStore((s) => s._hasHydrated)
  const appleHydrated = useItunesMetadataStore((s) => s._hasHydrated)
  const sources: ArtworkSource[] =
    props.kind === "artist" ? ["plex", "deezer"] : ["plex", "deezer", "apple"]
  const load = async (source: ArtworkSource, force = false) => {
    if (source === "plex") return null
    const store =
      source === "deezer"
        ? useDeezerMetadataStore.getState()
        : useItunesMetadataStore.getState()
    if (props.kind === "artist") {
      if (force) store.invalidateArtist(props.artistName)
      return store.getArtist(props.artistName)
    }
    if (!props.albumName) return null
    if (force) store.invalidateAlbum(props.artistName, props.albumName)
    return store.getAlbum(props.artistName, props.albumName)
  }
  useEffect(() => {
    active.current = true
    setBusy(true)
    if (!deezerHydrated || (props.kind === "album" && !appleHydrated))
      return () => {
        active.current = false
      }
    void Promise.allSettled(
      sources
        .filter((s) =>
          s === "deezer" ? deezerHydrated : s === "apple" && appleHydrated
        )
        .map((s) => load(s))
    ).then(() => {
      if (current()) setBusy(false)
    })
    return () => {
      active.current = false
    }
  }, [deezerHydrated, appleHydrated])
  useLayoutEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const native = typeof element.showModal === "function"
    const hidden: {
      node: Element
      aria: string | null
      inert: string | null
    }[] = []
    if (native) element.showModal()
    else {
      element.setAttribute("open", "")
      for (const node of [...document.body.children])
        if (node !== element) {
          hidden.push({
            node,
            aria: node.getAttribute("aria-hidden"),
            inert: node.getAttribute("inert"),
          })
          node.setAttribute("aria-hidden", "true")
          node.setAttribute("inert", "")
        }
    }
    close.current?.focus()
    const contain = (event: FocusEvent) => {
      if (!element.contains(event.target as Node)) close.current?.focus()
    }
    document.addEventListener("focusin", contain, true)
    return () => {
      document.removeEventListener("focusin", contain, true)
      if (native && element.open) element.close()
      document.body.style.overflow = overflow
      for (const { node, aria, inert } of hidden) {
        if (aria === null) node.removeAttribute("aria-hidden")
        else node.setAttribute("aria-hidden", aria)
        if (inert === null) node.removeAttribute("inert")
        else node.setAttribute("inert", inert)
      }
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  const choose = (source: ArtworkSource | null) => {
    useArtworkPreferenceStore.getState().setChoice(preferenceKey, source)
    setMessage(null)
  }
  return createPortal(
    <dialog
      ref={dialog}
      aria-modal="true"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Escape") {
          e.preventDefault()
          onClose()
        }
        if (e.key === "Tab") {
          const buttons = [
            ...dialog.current!.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)"
            ),
          ]
          const first = buttons[0],
            last = buttons.at(-1)
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last?.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first?.focus()
          }
        }
      }}
      className="fixed inset-0 z-[20000] m-auto max-h-[90vh] w-[min(92vw,680px)] overflow-y-auto rounded-xl border border-[var(--border)] bg-app-bg p-6 text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={id} className="text-xl font-semibold">
            Choose artwork
          </h2>
          <p className="mt-1 break-words text-sm text-[var(--text-secondary)]">
            {props.kind === "album"
              ? `${props.albumName} · ${props.artistName}`
              : props.artistName}
          </p>
        </div>
        <button
          ref={close}
          type="button"
          onClick={onClose}
          className="rounded-full px-3 py-2 text-sm hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Close
        </button>
      </div>
      <p role="status" className="mb-4 text-sm text-[var(--text-secondary)]">
        {artworkStatus(info)}
      </p>
      <button
        type="button"
        aria-pressed={!info.preference}
        onClick={() => choose(null)}
        className={`mb-4 w-full rounded-lg border p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${!info.preference ? "border-accent bg-accent-tint" : "border-[var(--border)] bg-app-surface"}`}
      >
        <span className="font-semibold">Automatic</span>
        <span className="mt-1 block text-sm text-[var(--text-secondary)]">
          Follow your global artwork source order.
        </span>
      </button>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-4">
        {sources.map((source) => (
          <button
            type="button"
            key={source}
            aria-label={`Use ${labels[source]} artwork`}
            aria-pressed={info.preference === source}
            onClick={() => choose(source)}
            className={`rounded-lg border p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${info.preference === source ? "border-accent bg-accent-tint" : "border-[var(--border)] bg-app-surface hover:bg-app-surface-hover"}`}
          >
            <div className="mb-3 aspect-square overflow-hidden rounded-md bg-app-bg">
              {info.candidates[source] ? (
                <ArtworkImage
                  src={info.candidates[source]!}
                  alt={`${labels[source]} artwork preview`}
                  onFailure={onFailure}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center p-2 text-center text-sm text-[var(--text-muted)]">
                  {busy && source !== "plex"
                    ? "Checking artwork…"
                    : "No matching artwork"}
                </div>
              )}
            </div>
            <span className="block text-sm font-semibold">
              {labels[source]}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-4 text-sm text-[var(--text-secondary)]">
        This choice applies to this item in your current library. Other
        available sources can appear if the selected artwork fails.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || !info.preference || info.preference === "plex"}
          onClick={() => {
            const source = info.preference
            if (!source || source === "plex") return
            setBusy(true)
            setMessage(null)
            void load(source, true)
              .then((result) => {
                if (current()) {
                  onRefresh()
                  setMessage(
                    result
                      ? "Artwork metadata refreshed."
                      : "No matching artwork was found. Your fallback remains available."
                  )
                }
              })
              .catch(() => {
                if (current())
                  setMessage(
                    "Could not refresh artwork metadata. Please try again."
                  )
              })
              .finally(() => {
                if (current()) setBusy(false)
              })
          }}
          className="rounded-full border border-[var(--border)] px-4 py-2 text-sm hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {busy ? "Checking artwork…" : "Refresh choices"}
        </button>
        <p className="text-xs text-[var(--text-muted)]">
          {props.refreshImage
            ? "Refresh choices checks metadata. Use Refresh image to reload this image’s cached bytes."
            : "Refresh choices checks metadata, not cached image bytes. Plex artwork refresh is unavailable here."}
        </p>
      </div>
      {props.refreshImage && (
        <button
          type="button"
          disabled={
            busy ||
            !(info.preference
              ? info.refreshTargets[info.preference]
              : info.source
                ? info.refreshTargets[info.source]
                : null)
          }
          className="mt-3 rounded-full border border-[var(--border)] px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          onClick={() => {
            const source = info.preference ?? info.source
            const url = source ? info.refreshTargets[source] : null
            if (!source || !url || !current()) return
            setBusy(true)
            setMessage(null)
            void props.refreshImage!(source, url)
              .then((result) => {
                if (current()) {
                  if (result && ownerScope.current)
                    useArtworkPreferenceStore
                      .getState()
                      .rememberRevision(
                        ownerScope.current,
                        url,
                        result.revision
                      )
                  onRefresh()
                  setMessage("Image refreshed.")
                }
              })
              .catch(() => {
                if (current())
                  setMessage("Could not refresh this image. Please try again.")
              })
              .finally(() => {
                if (current()) setBusy(false)
              })
          }}
        >
          Refresh image
        </button>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm text-[var(--text-secondary)]">
          {message}
        </p>
      )}
    </dialog>,
    document.body
  )
}
