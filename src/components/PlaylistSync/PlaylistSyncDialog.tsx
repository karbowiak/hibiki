import { useEffect, useMemo, useState, useId, useRef } from "react"
import { navigateSyncTabs } from "./PlaylistSyncFrame"
import { AppDialog } from "../shared/AppDialog"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { useLibraryStore } from "../../stores/libraryStore"
import {
  nativeListenBrainzPlaylists,
  listenBrainzPlaylistAdapter,
  type ListenBrainzPlaylistSummary,
  type ListenBrainzPlaylistListing,
} from "../../playlistSync/listenbrainz"
import {
  weeklySourceChannels,
  type WeeklySummary,
  type WeeklyChannel,
  type WeeklyEdition,
  type WeeklySourceBinding,
} from "../../playlistSync/weekly"
import type { PlaylistAccount } from "../../playlistSync/types"
import type { MusicPlaylist } from "../../types/music"
import type { PlaylistCopyServices } from "./services"
import type { LinkedPlaylistManagerServices } from "./LinkedPlaylistManager"
import { useLinkedPlaylistStore } from "../../stores/linkedPlaylistStore"
import type { LinkedPlaylist } from "../../playlistSync/linked"
import {
  SyncCreationError,
  type SyncCreationIntent,
} from "../../playlistSync/creation"
import { PlaylistCopyReceipts } from "./PlaylistCopyReceipts"
import { PlaylistCreationRecovery } from "./PlaylistCreationRecovery"
import { LinkedPlaylistManager } from "./LinkedPlaylistManager"
import { useCopyOwner } from "./useCopyOwner"
import { providerPlaylistAccount } from "../../playlistSync/provider"
import { samePlaylistIdentity } from "../../playlistSync/types"
function weeklyDate(edition: WeeklyEdition): string {
  return edition.weekOf
    ? `Week of ${edition.weekOf}`
    : `Generated ${new Date(edition.createdAt).toISOString().slice(0, 10)}`
}
const button =
  "rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
type SyncSummary = ListenBrainzPlaylistSummary & Pick<WeeklySummary, "weekly">
export interface PlaylistSyncBrowserServices {
  account(): Promise<PlaylistAccount>
  list(account: PlaylistAccount): Promise<ListenBrainzPlaylistListing>
  create?: (
    summary: ListenBrainzPlaylistSummary,
    title: string,
    current: () => boolean,
    weeklyEdition?: WeeklyEdition
  ) => Promise<{ intent: SyncCreationIntent; link: LinkedPlaylist }>
}
const defaultServices: PlaylistSyncBrowserServices = {
  account: () => nativeListenBrainzPlaylists.account(),
  list: (account) => listenBrainzPlaylistAdapter(account).listAll(),
}
/** One global entry: browsing is metadata-only; only the selected playlist is read. */
export function PlaylistSyncDialog({
  onClose,
  services = defaultServices,
  copyServices,
  linkServices,
}: {
  onClose(): void
  services?: PlaylistSyncBrowserServices
  copyServices?: PlaylistCopyServices
  linkServices?: LinkedPlaylistManagerServices
}) {
  const tabsId = useId()
  const creationPending = useRef<symbol | null>(null)
  const [createTitle, setCreateTitle] = useState("")
  const [chooseExisting, setChooseExisting] = useState(false)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [recoveredPlaylist, setRecoveredPlaylist] = useState<string | null>(
    null
  )
  const [creationReceipt, setCreationReceipt] =
    useState<SyncCreationIntent | null>(null)
  const provider = useProviderStore((s) => s.provider)
  const authenticated = useListenBrainzStore((s) => s.isAuthenticated),
    username = useListenBrainzStore((s) => s.username)
  const capture = useCopyOwner(provider, "global-sync")
  const owner = useMemo(
    () => ({}),
    [
      provider,
      provider?.cacheScope,
      provider?.playbackSession,
      authenticated,
      username,
      capture,
    ]
  )
  const [loadedOwner, setLoadedOwner] = useState<object | null>(null)
  const [items, setItems] = useState<SyncSummary[]>([]),
    [locals, setLocals] = useState<MusicPlaylist[]>([])
  const [loadedAccount, setLoadedAccount] = useState<PlaylistAccount | null>(
    null
  )
  const [listingComplete, setListingComplete] = useState(false)
  const [weeklyChoice, setWeeklyChoice] = useState<WeeklyChannel | null>(null)
  const [weeklyBinding, setWeeklyBinding] = useState<
    WeeklySourceBinding | undefined
  >()
  const [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0),
    [truncated, setTruncated] = useState(false)
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState<"all" | "created" | "generated" | "shared">(
      "all"
    ),
    [page, setPage] = useState(0)
  const [selected, setSelected] = useState<ListenBrainzPlaylistSummary | null>(
      null
    ),
    [localId, setLocalId] = useState("")
  const [step, setStep] = useState<
      "browse" | "destination" | "link" | "recovery"
    >("browse"),
    [writeBusy, setWriteBusy] = useState(false)
  const current = loadedOwner === owner
  const remote = current ? selected : null
  const links = useLinkedPlaylistStore((state) => state.links)
  const intents = useLinkedPlaylistStore((state) => state.creationIntents)
  const existingLink =
    provider?.cacheScope && remote
      ? links.find(
          (link) =>
            samePlaylistIdentity(
              link.library,
              providerPlaylistAccount(provider)
            ) &&
            link.listenbrainz.user === username &&
            (weeklyBinding
              ? link.weeklySource?.family === weeklyBinding.family
              : link.listenbrainzPlaylistId === remote.id)
        )
      : undefined
  const pendingReceipt =
    creationReceipt ??
    (provider?.cacheScope && remote
      ? intents.find(
          (intent) =>
            samePlaylistIdentity(
              intent.target,
              providerPlaylistAccount(provider)
            ) &&
            intent.sourceSnapshot.account.user === username &&
            intent.state !== "linked" &&
            intent.state !== "cancelled" &&
            (weeklyBinding
              ? intent.weeklyEdition?.family === weeklyBinding.family
              : intent.sourceSnapshot.id === remote.id)
        )
      : undefined)
  const ready =
    !!provider &&
    !provider.isOffline &&
    !!provider.capabilities.playlists &&
    authenticated &&
    !!username
  useEffect(() => {
    const owns = capture()
    setLoadedOwner(null)
    setLoadedAccount(null)
    setWeeklyChoice(null)
    setWeeklyBinding(undefined)
    setSelected(null)
    setStep("browse")
    setLocalId("")
    setError(null)
    setRecoveredPlaylist(null)
    creationPending.current = null
    setWriteBusy(false)
    setItems([])
    setLocals([])
    setPage(0)
    if (!ready || !provider) {
      setLoading(false)
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const account = await services.account()
        if (!owns()) return
        if (account.user !== username || account.service !== "listenbrainz")
          throw Error("Account changed")
        const [listing, library] = await Promise.all([
          services.list(account),
          provider.getPlaylists(),
        ])
        if (!owns()) return
        setItems(listing.items)
        setLoadedAccount(account)
        setListingComplete(listing.complete)
        setLocals(library.filter((p) => !p.smart))
        setTruncated(listing.truncated || !listing.complete)
        setLoadedOwner(owner)
      } catch {
        if (owns())
          setError(
            "Could not load ListenBrainz playlists. Check the connection and try again."
          )
      } finally {
        if (owns()) setLoading(false)
      }
    })()
  }, [owner, ready, services, retry])
  const channels = useMemo(() => {
    if (!current || !loadedAccount) return []
    try {
      return weeklySourceChannels(
        {
          items: items.filter((item) => !!item.weekly),
          complete: listingComplete,
        },
        loadedAccount
      )
    } catch {
      return []
    }
  }, [current, loadedAccount, items, listingComplete])
  const groupedIds = new Set(
    channels.flatMap((channel) =>
      channel.editions.map((edition) => edition.playlistId)
    )
  )
  function chooseEdition(channel: WeeklyChannel, edition: WeeklyEdition) {
    const summary = items.find((item) => item.id === edition.playlistId)
    if (!summary || !current) return
    setSelected(summary)
    setWeeklyBinding({
      family: edition.family,
      recipient: edition.recipient,
      edition,
    })
    setWeeklyChoice(null)
    setStep("destination")
    setLocalId("")
  }
  const filtered = (current ? items : []).filter((item) => {
    if (groupedIds.has(item.id)) return false
    const origin =
      filter === "all" ||
      (filter === "generated"
        ? item.access.generated
        : filter === "shared"
          ? item.access.origins.includes("collaborator")
          : item.access.origins.includes("created"))
    return (
      origin &&
      `${item.title} ${item.access.creator ?? ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase())
    )
  })
  const visibleChannels =
    filter === "all" || filter === "generated"
      ? channels.filter((channel) =>
          `${channel.label} ${channel.latest ? weeklyDate(channel.latest) : ""}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())
        )
      : []
  useEffect(() => {
    setCreateTitle(
      weeklyBinding
        ? weeklyBinding.family === "weekly-exploration"
          ? "Weekly Exploration"
          : "Weekly Jams"
        : (remote?.title ?? "")
    )
    setChooseExisting(false)
    setCreationError(null)
    setCreationReceipt(null)
  }, [remote?.id, weeklyBinding?.family])
  async function createSync() {
    if (!remote || creationPending.current || writeBusy || !createTitle.trim())
      return
    const request = Symbol("sync creation")
    creationPending.current = request
    const owns = capture()
    setWriteBusy(true)
    setCreationError(null)
    try {
      const result = await (
        services.create ?? useLinkedPlaylistStore.getState().createSync
      )(remote, createTitle, owns, weeklyBinding?.edition)
      if (!owns()) return
      setLocalId(result.link.libraryPlaylistId)
      setStep("link")
      void useLibraryStore.getState().fetchPlaylists({ force: true })
    } catch (error) {
      if (!owns()) return
      if (error instanceof SyncCreationError) setCreationReceipt(error.intent)
      setCreationError(
        error instanceof SyncCreationError
          ? "Creation needs recovery. Inspect the retained receipt before trying another create; no automatic retry was requested."
          : "Could not start sync. Check the original accounts and any retained creation before retrying."
      )
    } finally {
      if (creationPending.current === request) creationPending.current = null
      if (owns()) setWriteBusy(false)
    }
  }
  function back() {
    if (writeBusy) return
    setStep("browse")
    setSelected(null)
    setWeeklyChoice(null)
    setWeeklyBinding(undefined)
    setLocalId("")
  }
  return (
    <AppDialog
      title="Playlist sync"
      description={
        remote
          ? `${weeklyBinding ? (weeklyBinding.family === "weekly-exploration" ? "Weekly Exploration" : "Weekly Jams") : remote.title} · ListenBrainz → Plex`
          : `Choose a ListenBrainz playlist to sync with your library.`
      }
      onClose={onClose}
      canClose={!writeBusy}
      className="max-w-5xl"
    >
      {!ready ? (
        <div
          role="status"
          className="rounded-xl border border-[var(--border)] p-5"
        >
          <h3 className="font-semibold">Connect both services</h3>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Connect ListenBrainz and an online music library in Settings to
            configure playlist sync.
          </p>
        </div>
      ) : (
        <>
          {services === defaultServices && current && (
            <PlaylistCreationRecovery
              playlists={locals}
              onRecovered={(playlistId) => {
                setSelected(null)
                setStep("browse")
                setRecoveredPlaylist(playlistId)
                setCreationError(null)
                void useLibraryStore.getState().fetchPlaylists({ force: true })
              }}
            />
          )}
          {recoveredPlaylist && (
            <p
              role="status"
              className="mb-4 rounded-xl border border-[var(--border)] p-4"
            >
              The retained playlist link was recovered. Matching can continue in
              the background; open the playlist’s Sync review for any songs
              needing a choice.
            </p>
          )}
          {remote && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-app-surface p-4">
              <div className="min-w-0">
                <p className="break-words font-semibold">
                  {weeklyBinding
                    ? weeklyBinding.family === "weekly-exploration"
                      ? "Weekly Exploration"
                      : "Weekly Jams"
                    : remote.title}
                </p>
                {weeklyBinding && (
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {weeklyDate(weeklyBinding.edition)}
                  </p>
                )}
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {remote.access.generated
                    ? "Generated playlist"
                    : remote.access.owned
                      ? "Your playlist"
                      : "Shared playlist"}
                  {!remote.access.writable && " · Remote read-only"}
                </p>
              </div>
              <button className={button} disabled={writeBusy} onClick={back}>
                Choose another playlist
              </button>
            </div>
          )}
          {remote && (
            <div
              role="tablist"
              onKeyDown={navigateSyncTabs}
              aria-label="Selected ListenBrainz playlist"
              className="mb-4 flex flex-wrap gap-2"
            >
              <button
                role="tab"
                id={`${tabsId}-destination`}
                aria-controls={`${tabsId}-panel`}
                tabIndex={step !== "recovery" ? 0 : -1}
                aria-selected={step !== "recovery"}
                disabled={writeBusy}
                className={button}
                onClick={() => setStep("destination")}
              >
                Destination
              </button>
              <button
                role="tab"
                id={`${tabsId}-recovery`}
                aria-controls={`${tabsId}-panel`}
                tabIndex={step === "recovery" ? 0 : -1}
                aria-selected={step === "recovery"}
                disabled={writeBusy}
                className={button}
                onClick={() => setStep("recovery")}
              >
                Review previous copies
              </button>
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-[var(--border)] p-4"
            >
              {error}
              <button
                className={`${button} ml-3`}
                onClick={() => setRetry((v) => v + 1)}
              >
                Retry
              </button>
            </div>
          )}
          {loading && <p role="status">Loading playlist summaries…</p>}
          {(!remote || step === "browse") && (
            <section aria-label="ListenBrainz playlists">
              <div className="mb-4 flex flex-wrap gap-3">
                <input
                  aria-label="Find a ListenBrainz playlist"
                  placeholder="Find a playlist…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setPage(0)
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-app-surface px-3 py-2"
                />
                <select
                  aria-label="Playlist source"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value as typeof filter)
                    setPage(0)
                  }}
                  className={button}
                >
                  <option value="all">All playlists</option>
                  <option value="created">Created by you</option>
                  <option value="generated">Generated for you</option>
                  <option value="shared">Collaborations</option>
                </select>
              </div>
              {truncated && current && (
                <p
                  role="status"
                  className="mb-3 text-sm text-[var(--text-secondary)]"
                >
                  This is a bounded partial listing. Some playlists are
                  unavailable in this view; no missing playlists or songs will
                  be silently imported.
                </p>
              )}
              {!loading &&
                current &&
                filtered.length === 0 &&
                visibleChannels.length === 0 && (
                  <p
                    role="status"
                    className="py-8 text-center text-[var(--text-secondary)]"
                  >
                    {query
                      ? "No playlists match your search."
                      : "No playlists in this category."}
                  </p>
                )}
              {visibleChannels.length > 0 && (
                <section
                  aria-label="Weekly recommendation channels"
                  className="mb-5 grid gap-3 sm:grid-cols-2"
                >
                  {visibleChannels.map((channel) => (
                    <button
                      key={channel.family}
                      type="button"
                      className="rounded-xl border border-[var(--border)] bg-app-surface p-4 text-left hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      disabled={channel.status === "unavailable"}
                      onClick={() =>
                        channel.latest
                          ? chooseEdition(channel, channel.latest)
                          : setWeeklyChoice(channel)
                      }
                    >
                      <span className="block font-semibold">
                        {channel.label}
                      </span>
                      <span className="mt-1 block text-sm text-[var(--text-secondary)]">
                        {channel.latest
                          ? `${channel.label} · ${weeklyDate(channel.latest)}`
                          : channel.status === "ambiguous"
                            ? "Choose a verified edition before linking"
                            : "No verified edition available"}
                      </span>
                      <span className="mt-2 block text-xs text-[var(--text-secondary)]">
                        Generated for you · import-only
                      </span>
                    </button>
                  ))}
                </section>
              )}
              {weeklyChoice && (
                <section
                  aria-label="Choose a weekly edition"
                  className="mb-5 rounded-xl border border-[var(--border)] p-4"
                >
                  <h3 className="font-semibold">
                    {weeklyChoice.label}: review editions
                  </h3>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">
                    A unique latest edition could not be proven. Choose an
                    edition explicitly; automatic following stays unavailable
                    until a unique newer edition is verified.
                  </p>
                  <ul className="mt-3 space-y-2">
                    {weeklyChoice.editions.map((edition) => (
                      <li key={edition.playlistId}>
                        <button
                          className={button}
                          onClick={() => chooseEdition(weeklyChoice, edition)}
                        >
                          {weeklyDate(edition)} · {edition.createdAt} ·{" "}
                          {edition.playlistId.slice(-8)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <ul className="space-y-2">
                {filtered.slice(page * 30, (page + 1) * 30).map((item) => (
                  <li key={item.id}>
                    <button
                      className="flex w-full items-center gap-4 rounded-xl border border-[var(--border)] bg-app-surface p-4 text-left transition-colors hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      onClick={() => {
                        setSelected(item)
                        setWeeklyBinding(undefined)
                        setWeeklyChoice(null)
                        setStep("destination")
                        setLocalId("")
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className="bg-app-elevated flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl"
                      >
                        ♫
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-words font-medium">
                          {item.title || "Untitled playlist"}
                        </span>
                        <span className="mt-1 block text-xs text-[var(--text-secondary)]">
                          {item.access.generated
                            ? "Generated for you"
                            : item.access.owned
                              ? "Created by you"
                              : "Collaboration"}
                          {item.access.creator
                            ? ` · ${item.access.creator}`
                            : ""}
                          {!item.access.writable ? " · Read-only source" : ""}
                        </span>
                      </span>
                      <span aria-hidden="true">→</span>
                    </button>
                  </li>
                ))}
              </ul>
              {filtered.length > 30 && (
                <div className="mt-4 flex items-center justify-between gap-2">
                  <button
                    className={button}
                    disabled={page === 0}
                    onClick={() => setPage((v) => v - 1)}
                  >
                    Previous
                  </button>
                  <span className="text-sm text-[var(--text-secondary)]">
                    {page + 1} / {Math.ceil(filtered.length / 30)}
                  </span>
                  <button
                    className={button}
                    disabled={(page + 1) * 30 >= filtered.length}
                    onClick={() => setPage((v) => v + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </section>
          )}
          {remote && step === "destination" && (
            <section
              aria-label="Choose a Plex destination"
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-destination`}
              className="space-y-5"
            >
              <div className="rounded-xl border border-[var(--border)] bg-app-surface p-4">
                <label className="block text-sm">
                  Local playlist name
                  <input
                    aria-label="Local playlist name"
                    maxLength={500}
                    value={createTitle}
                    disabled={writeBusy || !!pendingReceipt || !!existingLink}
                    onChange={(event) => setCreateTitle(event.target.value)}
                    className={`${button} mt-2 w-full bg-app-surface`}
                  />
                </label>
                <button
                  className="media-primary mt-4"
                  disabled={
                    writeBusy || !createTitle.trim() || !!pendingReceipt
                  }
                  onClick={() => {
                    if (existingLink) {
                      setLocalId(existingLink.libraryPlaylistId)
                      setStep("link")
                    } else void createSync()
                  }}
                >
                  {writeBusy
                    ? "Creating sync…"
                    : existingLink
                      ? "Open configured sync"
                      : "Create Sync"}
                </button>
                <p className="mt-3 text-sm text-[var(--text-secondary)]">
                  Creates a fresh local playlist. Matching continues in the
                  background; songs needing a choice remain in its Review.
                </p>
                <p className="mt-2 text-xs text-[var(--text-secondary)]">
                  {weeklyBinding
                    ? "Follows new weekly editions while Hibiki is open or on next launch."
                    : "ListenBrainz → Plex · manual sync · automatic checks off."}
                </p>
              </div>
              {creationError && (
                <div
                  role="alert"
                  className="rounded-xl border border-[var(--border)] p-4"
                >
                  {creationError}
                  {creationReceipt?.destinationId && (
                    <p className="mt-2">
                      A local playlist ID was retained. Recover this creation
                      instead of creating a duplicate.
                    </p>
                  )}
                </div>
              )}
              <button
                className={button}
                disabled={writeBusy}
                onClick={() => setChooseExisting((value) => !value)}
              >
                Select existing local playlist
              </button>
              {chooseExisting && (
                <>
                  <label className="block text-sm">
                    Existing Plex playlist
                    <select
                      value={localId}
                      onChange={(e) => setLocalId(e.target.value)}
                      className={`${button} mt-2 w-full`}
                    >
                      <option value="">Choose a playlist</option>
                      {locals.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="media-primary"
                      disabled={!localId || !provider?.mutatePlaylistOccurrence}
                      onClick={() => setStep("link")}
                    >
                      Configure this link
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
          {remote && step === "link" && (
            <div
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-destination`}
            >
              <LinkedPlaylistManager
                key={`${remote.id}:${localId}`}
                playlistId={localId}
                selectedRemote={remote}
                weeklySource={weeklyBinding}
                initialDirection="import"
                services={linkServices}
                embedded
                onBusyChange={setWriteBusy}
                onClose={onClose}
              />
            </div>
          )}
          {remote && step === "recovery" && (
            <div
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-recovery`}
            >
              <PlaylistCopyReceipts
                embedded
                playlistId={remote.id}
                services={copyServices}
                onClose={onClose}
              />
            </div>
          )}
        </>
      )}
    </AppDialog>
  )
}
