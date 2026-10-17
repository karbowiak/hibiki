import { useProviderStore } from "../stores/providerStore"
import { useNotificationCenterStore } from "../stores/notificationCenterStore"
import {
  usePlayerStore,
  capturePlaybackSelectionVersion,
  currentQueueOwner,
  currentQueueOrderVersion,
  snapshotQueueEntries,
  queueSource,
  restorePlaybackQueue,
} from "../stores/playerStore"
import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import type { PagedTrackSource } from "./pagedPlayback"
import type { SavedQueue, SavedQueueState } from "./queueSession"
import { isYoutubeMusicId, youtubeMusicTrack } from "../backends/ytmusic/tracks"

export function restoredQueueSource(
  provider: MusicProvider,
  saved: SavedQueue
): PagedTrackSource {
  const { entries, state } = saved
  const pages = new Map<number, Promise<MusicTrack[]>>()
  const sourcePage = async (offset: number) => {
    let request = pages.get(offset)
    if (request) return request
    request = (async () => {
      if (state.sourceQuery && provider.getCollectionPage) {
        const q = state.sourceQuery
        const page = await provider.getCollectionPage(
          q.key,
          offset,
          200,
          q.filter,
          q.sort,
          q.dir === "desc" ? "desc" : "asc"
        )
        return page.items.filter((item) => item.type === "track")
      }
      if (state.sourceKey?.startsWith("playlist:"))
        return (
          await provider.getPlaylistItems(state.sourceKey.slice(9), offset, 200)
        ).items
      if (
        ["rated:track", "liked:rated"].includes(state.sourceKey ?? "") &&
        provider.getRatedItemsPage
      )
        return (
          await provider.getRatedItemsPage("track", offset, 200)
        ).items.filter((item) => item.type === "track")
      if (state.sourceKey?.startsWith("mix:/") && provider.getMixTracksPage)
        return (
          await provider.getMixTracksPage(state.sourceKey.slice(4), offset, 200)
        ).items
      throw Error(
        "Reconnect to Plex and open the original collection to rebuild this queue."
      )
    })()
    pages.set(offset, request)
    while (pages.size > 8) pages.delete(pages.keys().next().value!)
    void request.catch(() => pages.delete(offset))
    return request
  }
  const loadItems = async (positions: number[]) => {
    const selected = positions.map((index) => entries[index])
    const ids = [...new Set(selected.map((entry) => entry.id).filter(id => id && !isYoutubeMusicId(id)))]
    const cached = ids.length
      ? ((await provider.favorites?.cachedTracks?.(ids)) ?? [])
      : []
    const tracks = new Map(cached.map((track) => [track.id, track]))
    for (const entry of selected) {
      if (isYoutubeMusicId(entry.id)) tracks.set(entry.id, {
        ...youtubeMusicTrack({ videoId: entry.id.slice(8), title: entry.title ?? "YouTube Music song",
          artist: entry.artistName ?? "", album: entry.albumName ?? null, duration: null, thumbnail: null }),
        ...(entry.thumbUrl || entry.albumThumbUrl ? {
          thumbUrl: entry.thumbUrl || entry.albumThumbUrl,
          albumThumbUrl: entry.albumThumbUrl || entry.thumbUrl,
        } : {}),
        artistThumbUrl: entry.artistThumbUrl ?? null,
        duration: entry.duration ?? 0,
      })
    }
    const missing = ids.filter((id) => !tracks.has(id))
    for (let i = 0; i < missing.length; i += 4) {
      const results = await Promise.allSettled(
        missing.slice(i, i + 4).map((id) => provider.getTrack(id))
      )
      results.forEach((result) => {
        if (result.status === "fulfilled")
          tracks.set(result.value.id, result.value)
      })
    }
    return Promise.all(
      selected.map(async (entry) => {
        let track = tracks.get(entry.id)
        if (!track && !entry.id && entry.sourceIndex !== undefined) {
          const offset = Math.floor(entry.sourceIndex / 200) * 200
          track = (await sourcePage(offset))[entry.sourceIndex - offset]
        }
        if (!track)
          throw Error(
            "This saved song is unavailable. Reconnect to Plex or choose another queued song."
          )
        return entry.playlistItemId
          ? { ...track, playlistItemId: entry.playlistItemId }
          : track
      })
    )
  }
  return {
    key: state.sourceKey ?? "saved-queue",
    restoreQuery: state.sourceQuery,
    entries,
    total: entries.length,
    loadItems,
    loadPage: async (offset, limit) => ({
      items: await loadItems(
        Array.from(
          { length: Math.min(limit, entries.length - offset) },
          (_, i) => offset + i
        )
      ),
      total: entries.length,
      offset,
    }),
  }
}

let flush: () => Promise<void> = async () => {}
export const flushQueuePersistence = () => flush()

/** Save structural changes separately from the small, throttled playback cursor. */
export function initializeQueuePersistence() {
  let active = true,
    owner: MusicProvider | null = null,
    ready = false
  let serial = Promise.resolve(),
    timer: ReturnType<typeof setTimeout> | undefined
  let lastOrder = "",
    lastLength = -1,
    lastPositionSave = 0,
    failure: unknown
  const state = (): SavedQueueState => {
    const player = usePlayerStore.getState(),
      source = queueSource()
    return {
      index: player.queueIndex,
      positionMs: Math.max(0, player.positionMs),
      contextName: player.contextName,
      contextHref: player.contextHref,
      albumPlaybackId: player.albumPlaybackId,
      shuffle: player.shuffle,
      repeat: player.repeat,
      sourceKey: source?.key,
      sourceQuery: source?.restoreQuery,
    }
  }
  const save = (force = false) => {
    clearTimeout(timer)
    timer = undefined
    const captured = owner,
      player = usePlayerStore.getState()
    if (
      !active ||
      !ready ||
      !captured?.savedQueue ||
      currentQueueOwner() !== captured
    )
      return serial
    const order = currentQueueOrderVersion(),
      length = player.queue.length
    const structural = order !== lastOrder || length !== lastLength
    if (!structural && !force && Date.now() - lastPositionSave < 5000)
      return serial
    const cursor = state()
    const entries = structural && length ? snapshotQueueEntries() : null
    // Save stable music identities and artwork, never audio URLs or session credentials.
    // Public streams and podcasts retain their separate progress recovery.
    const supported = !entries?.some(
      (entry) => entry.id && !/^[1-9]\d*$/.test(entry.id) && !isYoutubeMusicId(entry.id)
    )
    const work = async () => {
      if (
        !active ||
        owner !== captured ||
        useProviderStore.getState().provider !== captured
      )
        return
      try {
        if (!length || !supported) await captured.savedQueue!.clear()
        else if (entries)
          await captured.savedQueue!.save({ entries, state: cursor })
        else await captured.savedQueue!.position(cursor)
        if (!active || owner !== captured) return
        lastOrder = order
        lastLength = length
        lastPositionSave = Date.now()
        failure = undefined
        useNotificationCenterStore.getState().resolve("queue.persistence")
      } catch (error) {
        if (!active || owner !== captured) return
        failure = error
        useNotificationCenterStore.getState().notify({
          id: "queue.persistence",
          title: "Queue could not be saved",
          message: "Your queue is still available in this window. Retry saving before quitting Hibiki.",
          severity: "warning",
          persistent: true,
          action: { label: "Retry saving", run: () => save(true) },
        })
        throw error
      }
    }
    serial = serial.catch(() => {}).then(work)
    void serial.catch(() => {})
    return serial
  }
  const schedule = () => {
    if (!ready || !owner || currentQueueOwner() !== owner || timer) return
    timer = setTimeout(() => {
      void save().catch(() => {})
    }, 500)
  }
  const activate = async (provider: MusicProvider | null) => {
    clearTimeout(timer)
    timer = undefined
    owner = provider
    ready = false
    lastOrder = ""
    lastLength = -1
    failure = undefined
    useNotificationCenterStore.getState().resolve("queue.persistence")
    if (!provider?.savedQueue) return
    const selection = capturePlaybackSelectionVersion()
    try {
      const saved = await provider.savedQueue.load()
      if (
        !active ||
        owner !== provider ||
        useProviderStore.getState().provider !== provider
      )
        return
      if (
        saved &&
        selection === capturePlaybackSelectionVersion() &&
        !usePlayerStore.getState().queue.length
      )
        await restorePlaybackQueue(
          provider,
          saved,
          restoredQueueSource(provider, saved)
        )
      if (!active || owner !== provider) return
      ready = true
      useNotificationCenterStore.getState().resolve("queue.persistence")
      if (
        saved &&
        currentQueueOwner() === provider &&
        selection === capturePlaybackSelectionVersion()
      ) {
        lastOrder = currentQueueOrderVersion()
        lastLength = usePlayerStore.getState().queue.length
      } else schedule()
    } catch (error) {
      if (!active || owner !== provider) return
      const oldBinary = /saved_queue.*not found|unknown.*saved_queue/i.test(String(error))
      useNotificationCenterStore.getState().notify({
        id: "queue.persistence",
        title: oldBinary ? "Restart Hibiki to enable saved queues" : "Saved queue could not be loaded",
        message: oldBinary
          ? "The running native app needs updating. Fully quit Hibiki and reopen the updated development app to enable queue saving."
          : "Your saved queue has been kept. Retry loading it to restore your songs and playback position.",
        severity: "warning",
        persistent: true,
        ...(oldBinary ? {} : { action: { label: "Retry loading", run: () => activate(provider) } }),
      })
    }
  }
  const unsubscribe = usePlayerStore.subscribe((player, previous) => {
    if (
      player.queue !== previous.queue ||
      player.queueIndex !== previous.queueIndex ||
      player.isPlaying !== previous.isPlaying ||
      player.repeat !== previous.repeat ||
      player.shuffle !== previous.shuffle ||
      Math.floor(player.positionMs / 5000) !==
        Math.floor(previous.positionMs / 5000)
    )
      schedule()
  })
  const providers = useProviderStore.subscribe((current, previous) => {
    if (current.provider !== previous.provider) void activate(current.provider)
  })
  void activate(useProviderStore.getState().provider)
  const flushThis = async () => {
    await save(true)
    if (failure)
      throw Error("Your queue could not be saved. Retry before closing Hibiki.")
  }
  flush = flushThis
  return () => {
    active = false
    clearTimeout(timer)
    unsubscribe()
    providers()
    if (flush === flushThis) flush = async () => {}
  }
}
