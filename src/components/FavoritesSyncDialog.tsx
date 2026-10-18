import { Checkbox } from "./shared/Checkbox"
import { Select } from "./shared/Select"
import { Button } from "./shared/Button"
import { useEffect, useState } from "react"
import { useFavoritesStore } from "../stores/favoritesStore"
import { useProviderStore } from "../stores/providerStore"
import { useLastfmStore } from "../metadata/lastfm/authStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { PlaylistSyncFrame } from "./PlaylistSync/PlaylistSyncFrame"
import type { FavoriteEntry, FavoriteService } from "../favorites/types"
import type { MusicPlaylist, MusicTrack } from "../types/music"
const names = { plex: "Plex", listenbrainz: "ListenBrainz", lastfm: "Last.fm" }
export function FavoritesSyncDialog({ onClose }: { onClose: () => void }) {
  const { collection, running, issues, error } = useFavoritesStore()
  const provider = useProviderStore((state) => state.provider)
  const [owner] = useState({ provider, session: provider?.playbackSession })
  const current = () =>
    useProviderStore.getState().provider === owner.provider &&
    owner.provider?.playbackSession === owner.session
  useEffect(
    () =>
      useProviderStore.subscribe(() => {
        if (!current()) onClose()
      }),
    [onClose, owner]
  )
  const lf = useLastfmStore((state) => state.isAuthenticated),
    lb = useListenBrainzStore((state) => state.isAuthenticated)
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]),
    [selected, setSelected] = useState(
      collection.bindings.plex?.playlistId ?? ""
    )
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string | null>(null),
    [review, setReview] = useState<FavoriteEntry | null>(null)
  const [idReview, setIdReview] = useState<FavoriteEntry | null>(null)
  const [recordingId, setRecordingId] = useState("")
  useEffect(() => {
    let active = true
    if (provider && !provider.isOffline)
      void provider
        .getPlaylists()
        .then((items) => {
          if (active) setPlaylists(items.filter((item) => !item.smart))
        })
        .catch(() => {})
    return () => {
      active = false
    }
  }, [provider])
  async function configure(service: FavoriteService, value: boolean) {
    if (!current()) return
    setBusy(true)
    setFailure(null)
    try {
      await useFavoritesStore
        .getState()
        .configure(
          service,
          value,
          service === "plex" &&
            value &&
            !collection.bindings.plex?.playlistId &&
            !collection.bindings.plex?.creation
            ? selected || undefined
            : undefined
        )
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : "Could not save sync settings"
      )
    } finally {
      setBusy(false)
    }
  }
  const missing = Object.values(collection.entries).filter(
    (item) => item.liked && !item.localTrackIds.length
  )
  const unresolvedIds = Object.values(collection.entries).filter(
    (item) => item.liked && !item.recordingMbid && !item.recordingMsid
  ).length
  return (
    <PlaylistSyncFrame
      title="Liked Songs sync"
      description="Your likes live in Hibiki. Choose where to keep them in sync."
      onClose={onClose}
      className="max-w-3xl"
    >
      <div className="space-y-5 p-5">
        <p className="text-sm text-(--text-secondary)">
          Each enabled connection syncs both ways. The first sync merges
          existing favorites; later likes and unlikes are shared between
          connected services. Three stars or more means liked in Hibiki.
        </p>
        {(["plex", "listenbrainz", "lastfm"] as FavoriteService[]).map(
          (service) => {
            const enabled = collection.settings[service],
              connected =
                service === "plex"
                  ? !!provider && !provider.isOffline
                  : service === "lastfm"
                    ? lf
                    : lb
            const binding = collection.bindings[service]
            return (
              <section
                key={service}
                className="rounded-xl border border-(--border) bg-app-surface p-4"
              >
                <label className="flex items-center justify-between gap-4 font-semibold">
                  {service === "plex"
                    ? "Sync likes to Plex"
                    : `Sync likes with ${names[service]}`}
                  <Checkbox
                    className="h-4 w-4 shrink-0 accent-accent"
                    checked={enabled}
                    disabled={busy || (!enabled && !connected)}
                    onChange={(event) =>
                      void configure(service, event.target.checked)
                    }
                  />
                </label>
                <p className="mt-2 text-sm text-(--text-secondary)">
                  {!connected
                    ? `Connect ${names[service]} in Settings to enable sync.`
                    : service === "plex"
                      ? "Mirror your favorites in a regular Liked Songs playlist. Adding or removing songs there updates Hibiki too."
                      : `Import existing loves from ${names[service]} and share future changes.`}
                </p>
                {service === "plex" &&
                  !binding?.playlistId &&
                  !binding?.creation && (
                    <label className="relative mt-3 block text-sm">
                      Plex destination
                      <Select
                        className="mt-1 w-full"
                        value={selected}
                        disabled={busy || enabled}
                        onChange={(event) => setSelected(event.target.value)}
                      >
                        <option value="">
                          Create a new Liked Songs playlist
                        </option>
                        {playlists.map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.title}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                {binding?.playlistId && (
                  <p className="mt-2 text-xs text-(--text-muted)">
                    Connected playlist:{" "}
                    {playlists.find((item) => item.id === binding.playlistId)
                      ?.title ?? "Liked Songs"}
                  </p>
                )}
                {binding?.creation && (
                  <div className="mt-3 text-sm">
                    <p>
                      Playlist creation needs inspection. Select the original
                      empty Liked Songs playlist to recover it.
                    </p>
                    <Select
                      className="mt-2 w-full"
                      value={selected}
                      onChange={(event) => setSelected(event.target.value)}
                    >
                      <option value="">Choose the inspected playlist</option>
                      {playlists
                        .filter((item) => item.title === "Liked Songs")
                        .map((item) => (
                          <option value={item.id} key={item.id}>
                            {item.title} · {item.trackCount} songs
                          </option>
                        ))}
                    </Select>
                    <Button
                      size="md"
                      variant="secondary"
                      className="media-secondary mt-2"
                      disabled={busy || !selected || running}
                      onClick={() => {
                        setBusy(true)
                        void useFavoritesStore
                          .getState()
                          .recoverPlex(selected)
                          .catch((error) => setFailure(error.message))
                          .finally(() => setBusy(false))
                      }}
                    >
                      Recover without creating
                    </Button>
                  </div>
                )}
                {issues[service] && (
                  <p className="mt-3 text-sm text-amber-400" role="status">
                    {issues[service]}
                  </p>
                )}
                {binding?.pending && (
                  <div className="mt-3 text-sm">
                    <p>
                      An unconfirmed {binding.pending.liked ? "like" : "unlike"}{" "}
                      is waiting to sync. Hibiki checks {names[service]} and{" "}
                      retries automatically.
                    </p>
                    <Button
                      size="md"
                      variant="secondary"
                      className="media-secondary mt-2"
                      disabled={running || busy}
                      onClick={() =>
                        void useFavoritesStore
                          .getState()
                          .sync({ retryUnknown: true })
                          .catch((error) => setFailure(error.message))
                      }
                    >
                      Check and retry pending changes
                    </Button>
                  </div>
                )}
              </section>
            )
          }
        )}
        <p className="text-sm text-(--text-secondary)">
          Three stars or more means liked. Lowering a rating below three stars
          or clearing it also unlikes the song in connected services. Imported
          likes display three stars in Hibiki and never write a rating to Plex.
        </p>
        <p className="text-xs text-(--text-muted)">
          Existing ratings and original liked dates are retained. Explicit star
          changes update the local liked state.
        </p>
        {collection.settings.listenbrainz && unresolvedIds > 0 && (
          <section className="space-y-3">
            <p className="text-sm text-(--text-secondary)">
              {unresolvedIds} favorites still need recording IDs before they can
              be sent to ListenBrainz. They remain saved in Hibiki.
            </p>
            <Button
              size="md"
              variant="secondary"
              className="media-secondary"
              disabled={running || busy}
              onClick={() => {
                setBusy(true)
                void useFavoritesStore
                  .getState()
                  .matchMissing(true)
                  .catch((error) => setFailure(error.message))
                  .finally(() => setBusy(false))
              }}
            >
              Find recording IDs
            </Button>
            <details>
              <summary className="cursor-pointer text-sm">
                Review missing recording IDs
              </summary>
              <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto">
                {Object.values(collection.entries)
                  .filter(
                    (item) =>
                      item.liked && !item.recordingMbid && !item.recordingMsid
                  )
                  .slice(0, 100)
                  .map((item) => (
                    <li
                      className="flex items-center justify-between gap-3 rounded-lg bg-app-surface p-3 text-sm"
                      key={item.id}
                    >
                      <span className="truncate">
                        {item.artist} — {item.title}
                      </span>
                      <Button
                        size="md"
                        variant="secondary"
                        className="media-secondary shrink-0"
                        onClick={() => {
                          setIdReview(item)
                          setRecordingId("")
                        }}
                      >
                        Choose recording ID
                      </Button>
                    </li>
                  ))}
              </ul>
            </details>
          </section>
        )}
        {idReview && (
          <form
            className="space-y-3 rounded-xl border border-(--border) p-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (!current() || busy) return
              setBusy(true)
              void useFavoritesStore
                .getState()
                .assignRecording(idReview.id, recordingId)
                .then(() => setIdReview(null))
                .catch((error) => setFailure(error.message))
                .finally(() => setBusy(false))
            }}
          >
            <h3 className="font-semibold">Recording ID for {idReview.title}</h3>
            <p className="text-sm text-(--text-secondary)">
              Paste the MusicBrainz recording ID you have checked for this song.
            </p>
            <input
              aria-label="MusicBrainz recording ID"
              className="w-full rounded-lg border border-(--border) bg-app-surface p-2"
              maxLength={36}
              value={recordingId}
              onChange={(event) => setRecordingId(event.target.value)}
            />
            <div className="flex gap-2">
              <Button size="md" type="submit" variant="primary"
                className="media-primary"
                disabled={busy || !recordingId.trim()}
              >
                Use this recording
              </Button>
              <Button
                size="md"
                variant="secondary"
                type="button"
                className="media-secondary"
                onClick={() => setIdReview(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {!!missing.length && (
          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold">
                {missing.length} songs to match to your library
              </h3>
              <Button
                size="md"
                variant="secondary"
                className="media-secondary"
                disabled={running || busy}
                onClick={() =>
                  void useFavoritesStore
                    .getState()
                    .matchMissing(true)
                    .catch((error) => setFailure(error.message))
                }
              >
                Find more matches
              </Button>
            </div>
            <ul className="mt-3 max-h-64 space-y-2 overflow-auto">
              {missing.slice(0, 100).map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-app-surface p-3 text-sm"
                >
                  <span className="truncate">
                    {item.artist || "Unknown artist"} —{" "}
                    {item.title || "Unknown recording"}
                  </span>
                  <Button
                    size="md"
                    variant="secondary"
                    className="media-secondary shrink-0"
                    onClick={() => setReview(item)}
                  >
                    Choose track
                  </Button>
                  <Button
                    size="md"
                    variant="secondary"
                    className="media-secondary shrink-0"
                    aria-label={`Unlike ${item.title || "recording"}`}
                    disabled={busy}
                    onClick={() =>
                      void useFavoritesStore
                        .getState()
                        .toggleEntry(item.id, false)
                        .catch((error) => setFailure(error.message))
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            {missing.length > 100 && (
              <p className="mt-2 text-sm text-(--text-muted)">
                Showing the first 100. Every unmatched song is retained.
              </p>
            )}
          </section>
        )}
        {review && (
          <FavoriteMatch entry={review} onClose={() => setReview(null)} />
        )}
        {(failure || error) && (
          <p role="alert" className="text-sm text-red-400">
            {failure || error}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-(--text-muted)">
            {running
              ? "Syncing favorites in the background…"
              : "Likes are available locally, including offline."}
          </span>
          <Button
            size="md"
            variant="primary"
            className="media-primary"
            disabled={
              running ||
              busy ||
              !!provider?.isOffline ||
              !(
                collection.settings.plex ||
                collection.settings.lastfm ||
                collection.settings.listenbrainz
              )
            }
            onClick={() =>
              void useFavoritesStore
                .getState()
                .sync()
                .catch((error) => setFailure(error.message))
            }
          >
            Sync now
          </Button>
        </div>
      </div>
    </PlaylistSyncFrame>
  )
}
function FavoriteMatch({
  entry,
  onClose,
}: {
  entry: FavoriteEntry
  onClose: () => void
}) {
  const provider = useProviderStore((state) => state.provider)
  const [query, setQuery] = useState(`${entry.artist} ${entry.title}`.trim()),
    [items, setItems] = useState<MusicTrack[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false)
  const [owner] = useState(provider?.playbackSession)
  const current = () =>
    useProviderStore.getState().provider === provider &&
    provider?.playbackSession === owner
  return (
    <section className="space-y-3 rounded-xl border border-(--border) p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Match {entry.title || "recording"}</h3>
        <Button size="md" variant="secondary" className="media-secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!provider || busy) return
          setBusy(true)
          void provider
            .search(query.slice(0, 500), "track")
            .then((items) => {
              if (current())
                setItems(
                  items.filter(
                    (item): item is MusicTrack & { type: "track" } =>
                      item.type === "track"
                  )
                )
            })
            .catch(() => setError("Search failed. Try again."))
            .finally(() => setBusy(false))
        }}
      >
        <input
          aria-label="Find a matching library track"
          className="min-w-0 flex-1 rounded-lg bg-app-surface p-2"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button size="md" type="submit" variant="secondary" className="media-secondary" disabled={busy || !query.trim()}>
          Search
        </Button>
      </form>
      <ul className="max-h-56 overflow-auto">
        {items.map((track) => (
          <li key={track.id}>
            <Button
              variant="bare"
              className="w-full rounded-lg p-2 text-left hover:bg-app-surface"
              disabled={busy}
              onClick={() => {
                if (!current()) return
                setBusy(true)
                void useFavoritesStore
                  .getState()
                  .linkTrack(entry.id, track)
                  .then(() => {
                    if (current()) onClose()
                  })
                  .catch(() => setError("Could not save this match"))
                  .finally(() => setBusy(false))
              }}
            >
              {track.artistName} — {track.title}
              <span className="block text-xs text-(--text-muted)">
                {track.albumName} · {track.codec} {track.bitrate}
              </span>
            </Button>
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
