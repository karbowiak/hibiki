import { listen } from "@tauri-apps/api/event"
import type { PlexRequestContext } from "../backends/plex/scopedApi"

export interface CatalogueCommittedUpdate {
  cacheScope: string
  connectionRevision: number
  changesRevision: number
  items?: { kind: "artist" | "album" | "track" | "playlist"; id: number }[]
}
interface UpdateClock {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

/** Keep a long-running stream from cancelling/restarting the same browse reads. */
export function createCatalogueRefreshQueue(
  owns: () => boolean,
  refresh: () => Promise<unknown>,
  clock: UpdateClock & { now(): number } = {
    now: () => performance.now(),
    setTimeout,
    clearTimeout,
  },
  interval = 10_000
) {
  let retired = false,
    running = false,
    pending = false
  let revision: number | null = null,
    lastStarted = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (retired || running || timer || !pending || !owns()) return
    timer = clock.setTimeout(
      () => {
        timer = null
        if (retired || !owns()) return
        running = true
        pending = false
        lastStarted = clock.now()
        void Promise.resolve()
          .then(() => {
            if (!retired && owns()) return refresh()
          })
          .catch(() => {
            /* A failed read must not retire future committed updates. */
          })
          .finally(() => {
            running = false
            schedule()
          })
      },
      Math.max(0, interval - (clock.now() - lastStarted))
    )
  }
  return {
    baseline(value: number) {
      if (revision === null && Number.isSafeInteger(value) && value >= 0)
        revision = value
    },
    offer(value: number) {
      if (
        retired ||
        !owns() ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        (revision !== null && value < revision)
      )
        return
      if (revision === value) {
        schedule()
        return
      }
      revision = value
      pending = true
      schedule()
    },
    stop() {
      retired = true
      pending = false
      if (timer) clock.clearTimeout(timer)
      timer = null
    },
  }
}

/** A revalidated hover/prefetch for another entity must not reload this page. */
export function metadataRefreshAffectsPage(
  method: string,
  args: unknown[],
  pathname: string,
  alternateAlbumIds: string[] = []
) {
  const page = /^\/(artist|album)\/([^/]+)\/?$/.exec(pathname)
  if (!page) return method === "getItemsByTag" && pathname.startsWith("/genre/")
  const id = String(args[0] ?? "")
  if (
    id !== page[2] &&
    !(page[1] === "album" && alternateAlbumIds.includes(id))
  )
    return false
  const common = ["getRelatedHubs"]
  return (
    page[1] === "artist"
      ? [
          ...common,
          "getArtist",
          "getArtistAlbums",
          "getArtistAlbumsInSection",
          "getArtistPopularTracks",
          "getArtistPopularTracksInSection",
          "getArtistSimilar",
          "getArtistStations",
        ]
      : [...common, "getAlbum", "getAlbumTracks"]
  ).includes(method)
}

/** Subscribe before async registration completes; retirement always wins. */
export function watchCatalogueUpdates(
  context: PlexRequestContext,
  owns: () => boolean,
  publish: (update: CatalogueCommittedUpdate) => void,
  subscribe: (
    receive: (update: CatalogueCommittedUpdate) => void
  ) => Promise<() => void> = (receive) =>
    listen<CatalogueCommittedUpdate>("catalogue_updated", (event) =>
      receive(event.payload)
    ),
  clock: UpdateClock = { setTimeout, clearTimeout }
) {
  const captured = Object.freeze({ ...context })
  let retired = false,
    unlisten: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | null = null
  let revision = 0,
    queuedRevision = 0
  const items = new Map<
    string,
    NonNullable<CatalogueCommittedUpdate["items"]>[number]
  >()
  const receive = (update: CatalogueCommittedUpdate) => {
    if (
      retired ||
      !owns() ||
      !update ||
      update.cacheScope !== captured.cacheScope ||
      update.connectionRevision !== captured.connectionRevision ||
      !Number.isSafeInteger(update.changesRevision) ||
      update.changesRevision <= revision
    )
      return
    queuedRevision = Math.max(queuedRevision, update.changesRevision)
    for (const item of Array.isArray(update.items) ? update.items : []) {
      if (items.size >= 2000) break
      if (
        item &&
        ["artist", "album", "track", "playlist"].includes(item.kind) &&
        Number.isSafeInteger(item.id) &&
        item.id > 0
      )
        items.set(`${item.kind}:${item.id}`, item)
    }
    if (timer) return
    timer = clock.setTimeout(() => {
      timer = null
      if (retired || !owns()) {
        items.clear()
        return
      }
      revision = queuedRevision
      const update = {
        ...captured,
        changesRevision: revision,
        items: [...items.values()],
      }
      items.clear()
      publish(update)
    }, 2000)
  }
  void Promise.resolve()
    .then(() => subscribe(receive))
    .then((stop) => {
      if (retired || !owns()) stop()
      else unlisten = stop
    })
    .catch(() => {
      /* Progress polling provides the same revision fallback. */
    })
  return () => {
    retired = true
    if (timer) clock.clearTimeout(timer)
    timer = null
    items.clear()
    unlisten?.()
  }
}
