import { useSoulSyncStore } from "../../metadata/soulsync/store"
import { nativeSoulSyncAdapter } from "../../metadata/soulsync/adapter"
import {
  useFanartServiceStore,
  useHeyaServiceStore,
} from "../../metadata/services/store"
import { useLastfmStore } from "../../metadata/lastfm/authStore"
import { metadataSourceAvailable } from "../../metadata/core/availability"
import { useTheAudioDbStore } from "../../metadata/theaudiodb/store"
import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  IconPencil,
  IconPhoto,
  IconDatabase,
  IconCheck,
  IconRefresh,
  IconMusic,
  IconLock,
} from "@tabler/icons-react"
import "../../styles/metadata-edit.css"
import { useMetadataSnapshot } from "../../hooks/useMetadataSnapshot"
import {
  metadataEditDraft,
  metadataEditError,
  planMetadataEdit,
  type MetadataEditItem,
  type MetadataEditKind,
} from "../../lib/metadataEdit"
import type { MusicAlbum, MusicArtist } from "../../types/music"
import type {
  MetadataField,
  MetadataIdentity,
  MetadataProviderSource,
} from "../../metadata/core/types"
import { existingMetadataProviders } from "../../metadata/core/existingProviders"
import {
  metadataSelectionFor,
  useMetadataSelectionStore,
} from "../../stores/metadataSelectionStore"
import { SOURCE_LABELS } from "../../stores/metadataSourceStore"
import { useProviderStore } from "../../stores/providerStore"
import { useLibraryStore } from "../../stores/libraryStore"
import { invalidateMetadataItem } from "../../stores/metadataCache"
import { AppDialog } from "./AppDialog"
import { MetadataIdentityPanel } from "./MetadataIdentityPanel"
import { PlexArtworkPanel } from "./PlexArtworkPanel"
import { AdvancedMetadataPanel } from "./AdvancedMetadataPanel"
import { ArtworkSourcePanel } from "./ArtworkSourcePicker"
import { ArtworkImage } from "./ArtworkImage"
import { useArtworkTone } from "../../hooks/useArtworkTone"
import { useAccentStore } from "../../stores/accentStore"
import {
  artworkUiPalette,
  fallbackArtworkTone,
} from "../../lib/artworkUiPalette"

export interface MetadataEditDialogProps {
  kind: MetadataEditKind
  item: MetadataEditItem
  onClose: () => void
  onSaved?: () => void
  artworkUrl?: string | null
  backgroundUrl?: string | null
}
const labels: Record<MetadataProviderSource, string> = {
  ...SOURCE_LABELS,
  soulsync: "SoulSync",
}
const fieldLabels: Partial<Record<MetadataField, string>> = {
  biography: "Biography",
  description: "Short description",
  summary: "Description",
  genres: "Genres",
  tags: "Tags",
  releaseDate: "Release date",
  label: "Record label",
  artistType: "Artist type",
  area: "Origin",
  beginDate: "Formed / born",
  listeners: "Listeners",
  playCount: "Plays",
  fans: "Fans",
  trackCount: "Tracks",
  mbid: "MusicBrainz identity",
  wikipediaUrl: "Wikipedia",
}
const button = "metadata-edit-button"
const input = "metadata-edit-input"
export function MetadataEditDialog({
  kind,
  item,
  onClose,
  onSaved,
  artworkUrl,
  backgroundUrl,
}: MetadataEditDialogProps) {
  const owner = useRef(useProviderStore.getState().provider).current
  const scope = useRef(owner?.cacheScope).current,
    session = useRef(owner?.playbackSession).current
  const active = useRef(true)
  const pending = useRef<"read" | "write" | null>(null)
  const reloadRequired = useRef(false)
  const current = () =>
    active.current &&
    useProviderStore.getState().provider === owner &&
    owner?.cacheScope === scope &&
    owner?.playbackSession === session
  const [baseline, setBaseline] = useState(item),
    [draft, setDraft] = useState(() => metadataEditDraft(kind, item))
  const [tab, setTab] = useState<
    "library" | "identity" | "advanced" | "sources" | "poster" | "background"
  >("library")
  const artworkRole = tab === "background" ? "background" : "poster"
  const tabId = useId()
  const tabs = useRef<HTMLButtonElement[]>([])
  const previewRef = useRef<HTMLElement>(null)
  const [preview, setPreview] = useState<ReturnType<
    typeof planMetadataEdit
  > | null>(null)
  const [busy, setBusy] = useState(false),
    [needsReload, setNeedsReload] = useState(false),
    [message, setMessage] = useState<string | null>(null)
  const [sourceMessage, setSourceMessage] = useState<string | null>(null)
  const coverUrl = artworkUrl === undefined ? baseline.thumbUrl : artworkUrl
  const backdropUrl =
    backgroundUrl === undefined
      ? kind === "artist"
        ? ((baseline as MusicArtist).artUrl ?? coverUrl)
        : coverUrl
      : backgroundUrl
  const accent = useAccentStore((state) => state.accent)
  const tone = useArtworkTone(coverUrl)
  const palette = artworkUiPalette(
    tone ?? fallbackArtworkTone(accent),
    typeof window === "undefined"
      ? "#282828"
      : window
          .getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-surface")
          .trim()
  )
  const identity: MetadataIdentity | null = useMemo(
    () =>
      kind === "playlist" || !scope
        ? null
        : {
            kind,
            entityId: item.id,
            scope,
            artist:
              kind === "artist"
                ? baseline.title
                : (baseline as MusicAlbum).artistName,
            ...(kind === "album" ? { title: baseline.title } : {}),
          },
    [
      kind,
      item.id,
      baseline.title,
      scope,
      kind === "album" ? (baseline as MusicAlbum).artistName : "",
    ]
  )
  const metadata = useMetadataSnapshot(
    identity,
    kind === "playlist" ? null : (baseline as MusicArtist | MusicAlbum)
  )
  const choices = useMetadataSelectionStore((state) => state.choices)
  const choice = identity ? metadataSelectionFor(identity, choices) : undefined
  const soulStatus = useSoulSyncStore((state) => state.status)
  const fanartStatus = useFanartServiceStore((state) => state.status)
  const heyaStatus = useHeyaServiceStore((state) => state.status)
  const audioDbStatus = useTheAudioDbStore((state) => state.status)
  const lastfmApiKey = useLastfmStore((state) => state.hasApiKey)
  const adapters = useMemo(
    () =>
      [
        ...existingMetadataProviders(),
              nativeSoulSyncAdapter(
                soulStatus,
                () => useSoulSyncStore.getState().status
              ),
      ].filter(
        (adapter) =>
          kind !== "playlist" &&
          !!adapter.fields[kind]?.length &&
          metadataSourceAvailable(adapter.id, {
            lastfmApiKey,
            soulsync: soulStatus,
            fanart: fanartStatus,
            heya: heyaStatus,
            theaudiodb: audioDbStatus,
          })
      ),
    [
      kind,
      soulStatus?.revision,
      fanartStatus?.revision,
      heyaStatus?.revision,
      audioDbStatus?.revision,
      lastfmApiKey,
    ]
  )
  const fields: MetadataField[] =
    kind === "artist"
      ? [
          "biography",
          "description",
          "genres",
          "tags",
          "artistType",
          "area",
          "beginDate",
          "listeners",
          "playCount",
          "fans",
          "mbid",
          "wikipediaUrl",
        ]
      : ["summary", "genres", "tags", "releaseDate", "label", "trackCount", "listeners", "playCount", "mbid"]
  const allowed =
    !!owner &&
    (kind === "playlist"
      ? owner.capabilities.playlistEdit && !(item as any).smart
      : owner.capabilities.metadataEdit && !!owner.editMetadata)
  useLayoutEffect(() => {
    if (preview?.changes.length && tab === "library") {
      previewRef.current?.focus({ preventScroll: true })
      previewRef.current?.scrollIntoView?.({ block: "start", behavior: "auto" })
    }
  }, [preview, tab])
  useEffect(() => {
    active.current = true
    const unsubscribe = useProviderStore.subscribe(() => {
      if (!current()) {
        active.current = false
        onClose()
      }
    })
    return () => {
      active.current = false
      unsubscribe()
    }
  }, [owner, scope, session, onClose])
  const changed = (field: keyof typeof draft, value: string) => {
    setDraft((old) => ({ ...old, [field]: value }))
    setPreview(null)
    setMessage(null)
  }
  const review = () => {
    try {
      const plan = planMetadataEdit(kind, baseline, draft)
      setPreview(plan)
      setMessage(plan.changes.length ? null : "There are no changes to save.")
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Check the edited fields."
      )
    }
  }
  const reload = async () => {
    if (!owner || !current() || pending.current) return
    pending.current = "read"
    setBusy(true)
    try {
      const fresh =
        kind === "artist"
          ? await owner.getArtist(item.id)
          : kind === "album"
            ? await owner.getAlbum(item.id)
            : (await owner.getPlaylists()).find(
                (playlist) => playlist.id === item.id
              )
      if (!current()) return
      if (!fresh) throw new Error("Missing item")
      setBaseline(fresh)
      setDraft(metadataEditDraft(kind, fresh))
      setPreview(null)
      setNeedsReload(false)
      reloadRequired.current = false
      setMessage("Current values loaded. Review your changes again.")
    } catch {
      if (current())
        setMessage(
          "Could not reload this item. Check your connection and try again."
        )
    } finally {
      pending.current = null
      if (current()) setBusy(false)
    }
  }
  const save = async () => {
    if (
      !owner ||
      !preview?.changes.length ||
      needsReload ||
      !allowed ||
      !current() ||
      pending.current ||
      reloadRequired.current
    )
      return
    pending.current = "write"
    setBusy(true)
    try {
      if (kind === "playlist") {
        const fresh = (await owner.getPlaylists()).find(
          (playlist) => playlist.id === item.id
        )
        if (!current()) return
        if (
          !fresh ||
          preview.changes.some(
            ({ field }) =>
              (field === "title" ? fresh.title : fresh.summary) !==
              preview.expected[field]
          )
        )
          throw new Error("Plex metadata changed")
        await owner.editPlaylist(
          item.id,
          preview.patch.title,
          preview.patch.summary
        )
      } else
        await owner.editMetadata!(
          kind,
          item.id,
          preview.patch,
          preview.expected
        )
      if (!current()) return
      const updated = { ...baseline, ...preview.patch }
      setBaseline(updated)
      setDraft(metadataEditDraft(kind, updated))
      setPreview(null)
      setMessage("Saved to Plex.")
      if (kind !== "playlist") invalidateMetadataItem(kind, item.id)
      const library = useLibraryStore.getState()
      if (kind === "playlist") {
        useLibraryStore.setState({
          playlists: library.playlists.map((playlist) =>
            playlist.id === item.id
              ? { ...playlist, ...preview.patch }
              : playlist
          ),
          currentPlaylist:
            library.currentPlaylist?.id === item.id
              ? { ...library.currentPlaylist, ...preview.patch }
              : library.currentPlaylist,
        })
      }
      library.invalidateLibraryTTLs()
      onSaved?.()
    } catch (error) {
      if (current()) {
        const result = metadataEditError(error)
        setMessage(result.message)
        setNeedsReload(result.reload)
        reloadRequired.current = result.reload
      }
    } finally {
      pending.current = null
      if (current()) setBusy(false)
    }
  }
  const select = (field: MetadataField, source: string) => {
    if (!identity || !current()) return
    const accepted = useMetadataSelectionStore
      .getState()
      .setChoice(
        identity,
        source ? (source as MetadataProviderSource) : null,
        field
      )
    setSourceMessage(
      accepted
        ? "Source choice applied in Hibiki. Any storage problem appears in Notifications."
        : "This choice could not be stored. Clear an older choice and try again."
    )
  }
  const dirty =
    draft.title.trim() !== baseline.title ||
    draft.summary !== (baseline.summary ?? "") ||
    (kind === "album" &&
      draft.releaseDate !== ((baseline as MusicAlbum).releaseDate ?? ""))
  const navigation = [
    { key: "library" as const, label: "General", icon: IconPencil },
    ...(kind === "playlist"
      ? []
      : [
          { key: "identity" as const, label: "Identity", icon: IconMusic },
          { key: "advanced" as const, label: "Fields and locks", icon: IconLock },
          {
            key: "sources" as const,
            label: "Metadata sources",
            icon: IconDatabase,
          },
          { key: "poster" as const, label: "Poster", icon: IconPhoto },
          { key: "background" as const, label: "Background", icon: IconPhoto },
        ]),
  ]
  return (
    <AppDialog
      title={`Edit ${kind}`}
      description={baseline.title}
      className="metadata-edit-dialog max-w-none"
      bodyClassName="min-h-0 overflow-hidden"
      style={palette}
      cover={
        <div
          className={`metadata-edit-cover ${coverUrl ? "" : "metadata-edit-cover--empty"}`}
        >
          {coverUrl ? (
            <ArtworkImage src={coverUrl} alt="" loading="eager" />
          ) : (
            <IconMusic size={30} aria-hidden="true" />
          )}
        </div>
      }
      headerBackdrop={
        <div className="metadata-edit-hero">
          {backdropUrl && (
            <ArtworkImage src={backdropUrl} alt="" loading="eager" />
          )}
        </div>
      }
      onClose={onClose}
      canClose={pending.current !== "write"}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            {tab === "library" ? (
              preview?.changes.length ? (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    setPreview(null)
                    setMessage(null)
                  }}
                >
                  Back to editing
                </button>
              ) : (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => void reload()}
                >
                  <IconRefresh size={15} aria-hidden="true" />
                  Reload current values
                </button>
              )
            ) : (
              <p className="metadata-edit-note">
                {tab === "advanced" ? "Fields and locks are saved to Plex." : tab === "poster" || tab === "background" ? "Artwork can be selected in Hibiki or saved to Plex." : "Preferences apply to this item in Hibiki."}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={button}
              disabled={pending.current === "write"}
              onClick={onClose}
            >
              {tab === "library" && dirty ? "Cancel" : "Done"}
            </button>
            {tab === "library" &&
              (preview?.changes.length ? (
                <button
                  type="button"
                  className={`${button} metadata-edit-button--primary`}
                  disabled={busy || needsReload || !allowed}
                  onClick={() => void save()}
                >
                  <IconCheck size={16} aria-hidden="true" />
                  {busy ? "Saving…" : "Save to Plex"}
                </button>
              ) : (
                <button
                  type="button"
                  className={`${button} metadata-edit-button--primary`}
                  disabled={busy || needsReload || !allowed || !dirty}
                  onClick={review}
                >
                  Review changes
                </button>
              ))}
          </div>
        </div>
      }
    >
      <div className="metadata-edit-layout">
        <div
          className="metadata-edit-nav"
          role="tablist"
          aria-label="Editing options"
        >
          {navigation.map(({ key, label, icon: Icon }, index) => (
            <div key={key} className="contents">
              {key === "poster" && (
                <p className="metadata-edit-nav-label" aria-hidden="true">
                  Artwork
                </p>
              )}
              <button
                key={key}
                ref={(element) => {
                  tabs.current[index] = element!
                }}
                type="button"
                role="tab"
                id={`${tabId}-${key}`}
                aria-controls={`${tabId}-panel`}
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                disabled={pending.current === "write"}
                className={`metadata-edit-tab ${key === "poster" || key === "background" ? "metadata-edit-tab--child" : ""}`}
                onClick={() => setTab(key)}
                onKeyDown={(event) => {
                  if (
                    ![
                      "ArrowUp",
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowRight",
                      "Home",
                      "End",
                    ].includes(event.key)
                  )
                    return
                  event.preventDefault()
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? navigation.length - 1
                        : (index +
                            (["ArrowUp", "ArrowLeft"].includes(event.key)
                              ? -1
                              : 1) +
                            navigation.length) %
                          navigation.length
                  setTab(navigation[next].key)
                  tabs.current[next]?.focus()
                }}
              >
                <Icon size={17} aria-hidden="true" />
                {label}
              </button>
            </div>
          ))}
        </div>
        <div
          className="metadata-edit-main"
          role="tabpanel"
          id={`${tabId}-panel`}
          aria-labelledby={`${tabId}-${tab}`}
        >
          {tab === "library" ? (
            <>
              {!allowed && (
                <p role="status" className="metadata-edit-note mb-4">
                  This provider or playlist does not support these edits.
                </p>
              )}
              {!preview?.changes.length && (
                <div className="metadata-edit-general">
                  <section className="metadata-edit-section">
                    <h3 className="metadata-edit-section-title">
                      {kind === "artist"
                        ? "Artist identity"
                        : kind === "album"
                          ? "Album details"
                          : "Playlist details"}
                    </h3>
                    <div className="space-y-5">
                      <label className="metadata-edit-label">
                        Title
                        <input
                          className={input}
                          value={draft.title}
                          disabled={busy || !allowed}
                          onChange={(event) =>
                            changed("title", event.target.value)
                          }
                        />
                      </label>
                      {kind === "album" && (
                        <>
                          <div>
                            <p className="metadata-edit-label">Artist</p>
                            <p className="mt-2 text-sm">
                              {(baseline as MusicAlbum).artistName}
                            </p>
                          </div>
                          <label className="metadata-edit-label">
                            Release date
                            <input
                              type="date"
                              className={input}
                              value={draft.releaseDate}
                              disabled={busy || !allowed}
                              onChange={(event) =>
                                changed("releaseDate", event.target.value)
                              }
                            />
                          </label>
                        </>
                      )}
                      <div className="border-t border-(--border) pt-4">
                        <p className="metadata-edit-label">Library metadata</p>
                        <p className="metadata-edit-note mt-2">
                          Review and save changes to your Plex library.
                        </p>
                        {kind !== "playlist" && (
                          <p className="metadata-edit-note mt-3 flex items-start gap-2">
                            <IconLock
                              size={14}
                              className="mt-0.5 shrink-0"
                              aria-hidden="true"
                            />
                            Saved fields are locked against automatic metadata
                            refresh.
                          </p>
                        )}
                      </div>
                    </div>
                  </section>
                  <section className="metadata-edit-section flex flex-col">
                    <h3 className="metadata-edit-section-title">
                      {kind === "artist" ? "Biography" : "Description"}
                    </h3>
                    <label className="metadata-edit-label flex min-h-0 flex-1 flex-col">
                      <span className="sr-only">Description</span>
                      <textarea
                        rows={10}
                        className={`${input} metadata-edit-description mt-0 flex-1`}
                        value={draft.summary}
                        disabled={busy || !allowed}
                        onChange={(event) =>
                          changed("summary", event.target.value)
                        }
                      />
                    </label>
                  </section>
                </div>
              )}
              {preview && preview.changes.length > 0 && (
                <section
                  ref={previewRef}
                  tabIndex={-1}
                  aria-label="Changes to save"
                  className="metadata-edit-section metadata-edit-preview"
                >
                  <h3 className="text-lg font-semibold">Changes to save</h3>
                  <p className="metadata-edit-note mt-2">
                    Review the current and proposed values before saving to
                    Plex.
                  </p>
                  {preview.changes.map((change) => (
                    <div
                      key={change.field}
                      className="metadata-edit-preview-row"
                    >
                      <p className="metadata-edit-label mb-3">{change.label}</p>
                      <div className="metadata-edit-preview-values">
                        <div>
                          <p className="metadata-edit-note mb-1">Current</p>
                          <p className="metadata-edit-preview-value">
                            {change.before || "Empty"}
                          </p>
                        </div>
                        <div>
                          <p className="metadata-edit-note mb-1">
                            After saving
                          </p>
                          <p className="metadata-edit-preview-value">
                            {change.after || "Empty"}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </section>
              )}
              {needsReload && (
                <button
                  type="button"
                  className={`${button} mt-4`}
                  disabled={busy}
                  onClick={() => void reload()}
                >
                  Reload current values
                </button>
              )}
              {message && (
                <p
                  role={needsReload ? "alert" : "status"}
                  aria-live="polite"
                  className="mt-4 rounded-lg border border-(--border) bg-app-surface px-4 py-3 text-sm"
                >
                  {message}
                </p>
              )}
            </>
          ) : tab === "advanced" && kind !== "playlist" ? (
            <AdvancedMetadataPanel kind={kind} itemId={baseline.id} disabled={busy || needsReload}
              onSavingChange={value => { pending.current = value ? "write" : null; setBusy(value) }}
              onSaved={() => { invalidateMetadataItem(kind, item.id); useLibraryStore.getState().invalidateLibraryTTLs(); onSaved?.() }} />
          ) : tab === "identity" && identity ? (
            <MetadataIdentityPanel identity={identity} disabled={busy || needsReload} />
          ) : tab === "poster" || tab === "background" ? (
            <div className="space-y-5">
              <div>
                <h3 className="text-lg font-semibold">
                  {artworkRole === "poster" ? "Poster" : "Background"}
                </h3>
                <p className="metadata-edit-note mt-1">
                  {artworkRole === "poster"
                    ? "Choose the image shown on cards and in the player."
                    : "Choose the image behind this page. Covers can also be reused as backgrounds."}
                </p>
              </div>
              <ArtworkSourcePanel
                key={artworkRole}
                role={artworkRole}
                kind={kind as "artist" | "album"}
                artistName={
                  kind === "artist"
                    ? baseline.title
                    : (baseline as MusicAlbum).artistName
                }
                albumName={kind === "album" ? baseline.title : undefined}
                plexThumb={baseline.thumbUrl}
                plexArt={(baseline as MusicArtist | MusicAlbum).artUrl ?? null}
                entityId={baseline.id}
              />
              <PlexArtworkPanel key={`${baseline.id}:${artworkRole}`} kind={kind as "artist" | "album"}
                itemId={baseline.id} role={artworkRole} disabled={needsReload || (busy && pending.current !== "write")}
                onBusy={(value) => { pending.current = value ? "write" : null; setBusy(value) }}
                onSaved={() => { invalidateMetadataItem(kind as "artist" | "album", item.id); useLibraryStore.getState().invalidateLibraryTTLs(); onSaved?.() }} />
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <h3 className="text-lg font-semibold">Metadata sources</h3>
                <p className="metadata-edit-note mt-1">
                  Choose enrichment for this item. Unavailable sources fall back
                  to your priority order; names remain from your library.
                </p>
              </div>
              <div
                className="flex flex-wrap gap-2"
                aria-label="Metadata source status"
              >
                {adapters.map((adapter) => {
                  const result = metadata.results[adapter.id]
                  const candidate =
                    result?.status === "ready" &&
                    result.snapshot?.match.kind === "candidate"
                  const requested = metadata.requestedSources.includes(
                    adapter.id
                  )
                  const status =
                    result?.status === "ambiguous"
                      ? "Multiple matches"
                      : candidate
                        ? "Needs verification"
                        : result?.status === "ready"
                          ? "Available"
                          : result?.status === "unavailable"
                            ? "Unavailable"
                            : result?.status === "unsupported"
                              ? "Unsupported"
                              : result?.status === "error"
                                ? "Try again"
                                : requested
                                  ? "Loading…"
                                  : "Choose a field"
                  return (
                    <div
                      key={adapter.id}
                      className="rounded-lg border border-(--border) bg-app-surface px-3 py-2 text-xs"
                    >
                      <strong>{labels[adapter.id]}</strong>
                      <span className="ml-2 text-(--text-secondary)">
                        {status}
                      </span>
                      <button
                        type="button"
                        className="ml-3 underline disabled:opacity-40"
                        disabled={!requested || (requested && !result)}
                        onClick={() => metadata.refresh(adapter.id)}
                      >
                        Refresh
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="metadata-edit-source-grid">
                {fields.map((field) => {
                  const resolved = metadata.resolveField(field),
                    selected = choice?.fields?.[field] ?? "",
                    value = resolved?.value
                  return (
                    <section
                      key={field}
                      className={`metadata-edit-section ${field === "biography" || field === "summary" ? "metadata-edit-source-long" : ""}`}
                    >
                      <div className="metadata-edit-source-title">
                        <h3 className="text-sm font-semibold">
                          {fieldLabels[field]}
                        </h3>
                        <select
                          aria-label={`${fieldLabels[field]} source`}
                          className={input}
                          value={selected}
                          onChange={(event) =>
                            select(field, event.target.value)
                          }
                        >
                          <option value="">Automatic</option>
                          <option value="plex">Plex</option>
                          {adapters
                            .filter((adapter) =>
                              adapter.fields[
                                kind as "artist" | "album"
                              ]?.includes(field)
                            )
                            .map((adapter) => {
                              const result = metadata.results[adapter.id],
                                unverified =
                                  result?.status === "ready" &&
                                  result.snapshot?.match.kind === "candidate"
                              return (
                                <option
                                  key={adapter.id}
                                  value={adapter.id}
                                  disabled={unverified}
                                >
                                  {labels[adapter.id]}
                                  {unverified ? " · Unverified match" : ""}
                                </option>
                              )
                            })}
                        </select>
                      </div>
                      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap wrap-break-word text-sm">
                        {Array.isArray(value)
                          ? value.join(", ")
                          : typeof value === "string" ||
                              typeof value === "number"
                            ? value
                            : metadata.isLoading
                              ? "Loading metadata…"
                              : "No matched metadata available."}
                      </p>
                      {resolved && (
                        <p className="metadata-edit-note mt-3">
                          {labels[resolved.source]}
                          {resolved.origin ? ` · ${resolved.origin}` : ""}
                          {resolved.fallback ? " · Fallback" : ""} ·{" "}
                          {resolved.match.kind === "library"
                              ? "Library metadata"
                            : resolved.match.kind === "reviewed-identity" ? "Reviewed identity" : "Matching names"}
                        </p>
                      )}
                      {allowed &&
                        (field === "biography" || field === "summary") &&
                        typeof value === "string" &&
                        value !== draft.summary && (
                          <button
                            type="button"
                            className={`${button} mt-3`}
                            onClick={() => {
                              if (current()) {
                                changed("summary", value)
                                setTab("library")
                              }
                            }}
                          >
                            Use for Plex description
                          </button>
                        )}
                    </section>
                  )
                })}
              </div>
              {sourceMessage && (
                <p
                  role="status"
                  aria-live="polite"
                  className="metadata-edit-note"
                >
                  {sourceMessage}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </AppDialog>
  )
}
