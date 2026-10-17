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
  type ArtworkRole,
} from "../../stores/artworkPreferenceStore"
import { useDeezerMetadataStore } from "../../metadata/deezer/store"
import { useHeyaArtworkStore } from "../../metadata/heya/artworkStore"
import { useFanartMetadataStore } from "../../metadata/fanart/store"
import { theAudioDb, useTheAudioDbStore } from "../../metadata/theaudiodb/store"
import { resolveMetadataIdentity } from "../../metadata/identity/resolve"
import {
  useFanartServiceStore,
  useHeyaServiceStore,
} from "../../metadata/services/store"
import { useCoverArtArchiveMetadataStore } from "../../metadata/coverartarchive/store"
import { useItunesMetadataStore } from "../../metadata/apple/store"
import { ArtworkImage, useArtworkFailures } from "./ArtworkImage"

const labels: Record<ArtworkSource, string> = {
  plex: "Plex",
  deezer: "Deezer",
  apple: "Apple Music",
  coverartarchive: "Cover Art Archive",
  fanart: "Fanart.tv",
  heya: "Heya Metadata",
  theaudiodb: "TheAudioDB",
}
export interface ArtworkSourcePickerProps {
  kind: ArtworkKind
  artistName: string
  albumName?: string | null
  plexThumb: string | null
  /** Independent Plex background/art URI; never substitute the poster implicitly. */
  plexArt?: string | null
  role?: ArtworkRole
  entityId?: string | null
  className?: string
  label?: string
  iconOnly?: boolean
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
function useArtworkSourceResolution(props: ArtworkSourcePickerProps) {
  const heyaRevision = useHeyaServiceStore((s) => s.status?.revision)
  const fanartRevision = useFanartServiceStore((s) => s.status?.revision)
  const audioDbRevision = useTheAudioDbStore((s) => s.status?.revision)
  const provider = useProviderStore((s) => s.provider)
  const scope = useProviderStore((s) => s.provider?.cacheScope)
  const session = useProviderStore((s) => s.provider?.playbackSession)
  const refreshImage =
    props.refreshImage ??
    (isTauri()
      ? (_source: ArtworkSource, url: string) => refreshNativeImage(url)
      : undefined)
  const key = artworkPreferenceKey(
    provider?.cacheScope,
    props.kind,
    props.artistName,
    props.albumName,
    props.role ?? "poster"
  )
  const [refresh, setRefresh] = useState(0)
  const { failures, onFailure } = useArtworkFailures(
    JSON.stringify([
      key,
      props.role === "background" ? props.plexArt : props.plexThumb,
      refresh,
    ])
  )
  const plexImage =
    props.role === "background" ? (props.plexArt ?? null) : props.plexThumb
  const artist = useArtistArtwork(
    props.kind === "artist" ? props.artistName : null,
    props.kind === "artist" ? plexImage : null,
    props.entityId,
    failures,
    true,
    props.role ?? "poster"
  )
  const album = useAlbumArtwork(
    props.kind === "album" ? props.artistName : null,
    props.kind === "album" ? (props.albumName ?? null) : null,
    props.kind === "album" ? plexImage : null,
    props.entityId,
    failures,
    true,
    props.role ?? "poster"
  )
  const info = props.kind === "artist" ? artist : album
  const identity = useRef({ provider, scope, session, serial: 0 })
  if (
    identity.current.provider !== provider ||
    identity.current.scope !== scope ||
    identity.current.session !== session
  ) {
    identity.current = {
      provider,
      scope,
      session,
      serial: identity.current.serial + 1,
    }
  }
  return {
    preferenceKey: key,
    info,
    onFailure,
    onRefresh: () => setRefresh((x) => x + 1),
    refreshImage,
    ownerKey: JSON.stringify([
      key,
      identity.current.serial,
      props.entityId,
      plexImage,
      fanartRevision,
      heyaRevision,
      audioDbRevision,
    ]),
  }
}

/** Inline artwork choices: the containing editor owns its dialog and focus. */
export function ArtworkSourcePanel(props: ArtworkSourcePickerProps) {
  const resolution = useArtworkSourceResolution(props)
  if (!resolution.preferenceKey)
    return (
      <p role="status" className="text-sm text-(--text-secondary)">
        Connect an account-scoped library to choose artwork for this item.
      </p>
    )
  return (
    <ArtworkSourcePanelContent
      key={resolution.ownerKey}
      {...props}
      {...resolution}
      preferenceKey={resolution.preferenceKey}
    />
  )
}

export function ArtworkSourcePicker(props: ArtworkSourcePickerProps) {
  const {
    preferenceKey: key,
    info,
    onFailure,
    onRefresh,
    refreshImage,
    ownerKey,
  } = useArtworkSourceResolution(props)
  const [openFor, setOpenFor] = useState<string | null>(null)
  const open = !!key && openFor === ownerKey
  return (
    <>
      <button
        type="button"
        aria-label={
          props.iconOnly ? (props.label ?? "Artwork sources") : undefined
        }
        disabled={!key}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true })
          setOpenFor(ownerKey)
        }}
        className={
          props.className ??
          "rounded-full border border-(--border) bg-app-surface px-3 py-2 text-sm text-(--text-primary) hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        }
      >
        {props.iconOnly ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m16 3 5 5-12 12-6 1 1-6L16 3Z" />
            <path d="m14 5 5 5" />
          </svg>
        ) : (
          (props.label ?? "Artwork sources")
        )}
      </button>
      {open && key && (
        <SourceDialog
          {...props}
          refreshImage={refreshImage}
          preferenceKey={key}
          info={info}
          onFailure={onFailure}
          onRefresh={onRefresh}
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
      className="fixed inset-0 z-20000 m-auto max-h-[90vh] w-[min(92vw,680px)] overflow-y-auto rounded-xl border border-(--border) bg-app-bg p-6 text-(--text-primary) shadow-2xl backdrop:bg-black/70"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={id} className="text-xl font-semibold">
            Choose artwork
          </h2>
          <p className="mt-1 wrap-break-word text-sm text-(--text-secondary)">
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
      <ArtworkSourcePanelContent
        {...props}
        className={undefined}
        preferenceKey={preferenceKey}
        info={info}
        onFailure={onFailure}
        onRefresh={onRefresh}
      />
    </dialog>,
    document.body
  )
}

type ArtworkSourcePanelContentProps = ArtworkSourcePickerProps & {
  preferenceKey: string
  info: ArtworkResolution
  onFailure: (url: string) => void
  onRefresh: () => void
}
function ArtworkSourcePanelContent({
  preferenceKey,
  info,
  onFailure,
  onRefresh,
  ...props
}: ArtworkSourcePanelContentProps) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const active = useRef(true)
  const refreshing = useRef(false)
  const owner = useRef(useProviderStore.getState().provider)
  const ownerScope = useRef(owner.current?.cacheScope)
  const ownerSession = useRef(owner.current?.playbackSession)
  const heyaServiceRevision = useRef(
    useHeyaServiceStore.getState().status?.revision
  )
  const serviceRevision = useRef(
    useFanartServiceStore.getState().status?.revision
  )
  const audioDbServiceRevision = useRef(useTheAudioDbStore.getState().status?.revision)
  const current = () =>
    active.current &&
    useProviderStore.getState().provider === owner.current &&
    owner.current?.cacheScope === ownerScope.current &&
    owner.current?.playbackSession === ownerSession.current &&
    useFanartServiceStore.getState().status?.revision ===
      serviceRevision.current &&
    useHeyaServiceStore.getState().status?.revision ===
      heyaServiceRevision.current
      && useTheAudioDbStore.getState().status?.revision === audioDbServiceRevision.current
  const deezerHydrated = useDeezerMetadataStore((s) => s._hasHydrated)
  const appleHydrated = useItunesMetadataStore((s) => s._hasHydrated)
  const caaHydrated = useCoverArtArchiveMetadataStore((s) => s._hasHydrated)
  const heyaStatus = useHeyaServiceStore((s) => s.status)
  const heyaHydrated = useHeyaArtworkStore((s) => s._hasHydrated)
  useEffect(() => {
    if (!heyaStatus) void useHeyaServiceStore.getState().load()
  }, [heyaStatus])
  const fanartStatus = useFanartServiceStore((s) => s.status)
  const fanartHydrated = useFanartMetadataStore((s) => s._hasHydrated)
  const audioDbStatus = useTheAudioDbStore((s) => s.status)
  useEffect(() => {
    if (!audioDbStatus) void useTheAudioDbStore.getState().load()
  }, [audioDbStatus])
  useEffect(() => {
    if (!fanartStatus) void useFanartServiceStore.getState().load()
  }, [fanartStatus])
  const sources: ArtworkSource[] = (
    props.kind === "artist"
      ? ["plex", "deezer", "fanart", "heya", "theaudiodb"]
      : ["plex", "deezer", "apple", "coverartarchive", "fanart", "heya", "theaudiodb"]
  ).filter((source) =>
    source === "fanart"
      ? !!fanartStatus?.configured && fanartStatus.enabled
      : source === "heya"
        ? !!heyaStatus?.configured && heyaStatus.enabled
        : source === "theaudiodb"
          ? !!audioDbStatus?.configured && audioDbStatus.enabled
        : true
  ) as ArtworkSource[]
  const load = async (source: ArtworkSource, force = false) => {
    if (source === "plex") return null
    if (source === "theaudiodb") {
      if (!audioDbStatus?.configured || !audioDbStatus.enabled || owner.current?.isOffline || !ownerScope.current) return null
      const original = { kind: props.kind, artist: props.artistName, title: props.albumName ?? undefined, entityId: props.entityId ?? undefined, scope: ownerScope.current }
      const reviewed = resolveMetadataIdentity(original)
      if (!reviewed.ready) return null
      const identity = { ...original, artist: reviewed.lookupArtist, title: reviewed.lookupTitle }
      const mbid = props.kind === "artist" ? reviewed.artistMbid : reviewed.releaseGroupMbid
      if (force) theAudioDb.invalidate(identity)
      return theAudioDb.lookup(identity, mbid)
    }
    if (source === "heya" && (!heyaStatus?.enabled || !heyaStatus.configured))
      return null
    if (
      source === "fanart" &&
      (!fanartStatus?.enabled || !fanartStatus.configured)
    )
      return null
    const store =
      source === "heya"
        ? useHeyaArtworkStore.getState()
        : source === "fanart"
          ? useFanartMetadataStore.getState()
          : source === "deezer"
            ? useDeezerMetadataStore.getState()
            : source === "coverartarchive"
              ? useCoverArtArchiveMetadataStore.getState()
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
    if (
      !deezerHydrated ||
      (props.kind === "album" && (!appleHydrated || !caaHydrated))
    )
      return () => {
        active.current = false
      }
    void Promise.allSettled(
      sources
        .filter((s) =>
          s === "deezer"
            ? deezerHydrated
            : s === "apple"
              ? appleHydrated
              : s === "coverartarchive"
                ? caaHydrated
                : s === "theaudiodb"
                  ? !!audioDbStatus?.configured && audioDbStatus.enabled
                : s === "heya"
                  ? heyaHydrated &&
                    !!heyaStatus?.configured &&
                    heyaStatus.enabled
                  : s === "fanart" &&
                    fanartHydrated &&
                    !!fanartStatus?.configured &&
                    fanartStatus.enabled
        )
        .map((s) => load(s))
    ).then(() => {
      if (current()) setBusy(false)
    })
    return () => {
      active.current = false
    }
  }, [
    deezerHydrated,
    appleHydrated,
    caaHydrated,
    fanartHydrated,
    fanartStatus,
    heyaStatus,
    heyaHydrated,
    audioDbStatus,
  ])
  const selectedCandidate = useArtworkPreferenceStore(
    (s) => s.candidateChoices[preferenceKey]
  )
  const choose = (source: ArtworkSource | null, id?: string) => {
    if (!current()) return
    if (source && id && id !== "default")
      useArtworkPreferenceStore
        .getState()
        .setCandidate(preferenceKey, source, id)
    else useArtworkPreferenceStore.getState().setChoice(preferenceKey, source)
    setMessage(null)
  }
  return (
    <div className={props.className}>
      {props.role === "background" && (
        <p className="mb-3 text-sm text-(--text-secondary)">
          Provider background art is separate from posters. Artist
          images and album covers can also be reused as a background; those
          choices are labeled as reused covers.
        </p>
      )}
      <p role="status" className="mb-4 text-sm text-(--text-secondary)">
        {artworkStatus(info)}
      </p>
      <button
        type="button"
        aria-pressed={!info.preference}
        onClick={() => choose(null)}
        className={`mb-4 w-full rounded-lg border p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${!info.preference ? "border-accent bg-accent-tint" : "border-(--border) bg-app-surface"}`}
      >
        <span className="font-semibold">Automatic</span>
        <span className="mt-1 block text-sm text-(--text-secondary)">
          {props.role === "background"
            ? "Prefer Plex background art, then follow your source order. Reused covers are labeled. Poster choices stay separate."
            : "Follow your global artwork source order."}
        </span>
      </button>
      <div
        className={`grid gap-2 ${props.role === "background" ? "grid-cols-[repeat(auto-fill,minmax(150px,200px))]" : "grid-cols-[repeat(auto-fill,minmax(104px,132px))]"}`}
      >
        {sources.flatMap((source) =>
          (info.images[source]?.length
            ? info.images[source]!
            : [{ id: "default", url: "" }]
          ).map((image, imageIndex) => (
            <button
              type="button"
              key={`${source}:${image.id}`}
              disabled={(source === "heya" || source === "theaudiodb") && !image.url}
              aria-label={
                props.role === "background"
                  ? `Use ${labels[source]} ${["plex", "fanart", "heya", "theaudiodb"].includes(source) ? "background" : props.kind === "artist" ? "artist image as background" : "album cover as background"}${image.id === "default" ? "" : ` ${image.label ?? imageIndex + 1}`}`
                  : `Use ${labels[source]} artwork${image.id === "default" ? "" : ` ${image.label ?? imageIndex + 1}`}`
              }
              aria-pressed={
                info.preference === source &&
                (selectedCandidate?.source === source
                  ? selectedCandidate.id === image.id
                  : imageIndex === 0)
              }
              onClick={() => choose(source, image.id)}
              className={`rounded-lg border p-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${info.preference === source && (selectedCandidate?.source === source ? selectedCandidate.id === image.id : imageIndex === 0) ? "border-accent bg-accent-tint" : "border-(--border) bg-app-surface hover:bg-app-surface-hover"}`}
            >
              <div
                className={`mb-2 ${props.role === "background" ? "aspect-video" : "aspect-square"} overflow-hidden rounded-md bg-app-bg`}
              >
                {image.url ? (
                  <ArtworkImage
                    src={image.url}
                    alt={`${labels[source]} artwork preview`}
                    onFailure={onFailure}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-2 text-center text-sm text-(--text-muted)">
                    {busy && source !== "plex"
                      ? "Checking artwork…"
                      : source === "heya"
                        ? !heyaStatus?.configured || !heyaStatus.enabled
                          ? "Configure HeyaMetadata in Settings"
                          : "No matching artwork"
                        : source === "fanart" &&
                            (!fanartStatus?.configured || !fanartStatus.enabled)
                          ? "Configure Fanart.tv in Settings"
                          : "No matching artwork"}
                  </div>
                )}
              </div>
              <span className="block text-sm font-semibold">
                {labels[source]}
              </span>
              {image.url && image.url === info.url && (
                <span className="mt-1 block text-xs font-medium text-accent">
                  Current image
                </span>
              )}
              {image.label && (
                <span className="mt-1 block text-xs text-(--text-secondary)">
                  {image.label}
                </span>
              )}
            </button>
          ))
        )}
      </div>
      <p className="mt-4 text-sm text-(--text-secondary)">
        This choice applies to this item in your current library. Other
        available sources can appear if the selected artwork fails.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || !info.preference || info.preference === "plex"}
          onClick={() => {
            const source = info.preference
            if (
              !source ||
              source === "plex" ||
              !current() ||
              refreshing.current
            )
              return
            refreshing.current = true
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
                refreshing.current = false
                if (current()) setBusy(false)
              })
          }}
          className="rounded-full border border-(--border) px-4 py-2 text-sm hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {busy ? "Checking artwork…" : "Refresh choices"}
        </button>
        <p className="text-xs text-(--text-muted)">
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
          className="mt-3 rounded-full border border-(--border) px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          onClick={() => {
            const source = info.preference ?? info.source
            const url = source ? info.refreshTargets[source] : null
            if (!source || !url || !current() || refreshing.current) return
            refreshing.current = true
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
                        result.revision,
                        props.role ?? "poster"
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
                refreshing.current = false
                if (current()) setBusy(false)
              })
          }}
        >
          Refresh image
        </button>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm text-(--text-secondary)">
          {message}
        </p>
      )}
    </div>
  )
}
