import type { FromWorker, ToWorker, WorkerContext, Progress } from "./protocol"
import {
  newestRatings,
  newestRows,
  StateSnapshots,
  workerData,
} from "./protocol"

const scope = globalThis as any
scope.__HIBIKI_BACKGROUND_WORKER__ = true
scope.isTauri = true
let context: WorkerContext | undefined,
  sequence = 0
const replies = new Map<
  number,
  { resolve(value: any): void; reject(error: Error): void }
>()
const callbacks = new Map<
  number,
  { callback(value: any): void; once: boolean }
>()
const post = (message: FromWorker) => scope.postMessage(message)
function rpc(
  kind: "invoke" | "provider",
  method: string,
  args: any,
  owner = context?.owner ?? ""
) {
  const id = ++sequence
  const promise = new Promise((resolve, reject) =>
    replies.set(id, { resolve, reject })
  )
  post({ type: "rpc", id, owner, kind, method, args })
  return promise
}
// A narrow adapter for the public Tauri API used by domain modules. Native IPC
// still originates in the trusted main webview and is fenced by its live owner.
scope.window = {
  __TAURI_INTERNALS__: {
    invoke: (method: string, args: any) => rpc("invoke", method, args),
    transformCallback: (callback: (value: any) => void, once = false) => {
      const id = ++sequence
      callbacks.set(id, { callback, once })
      return id
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
}
const ready = (async () => {
  const [
    { backgroundDomains },
    { useProviderStore },
    { useYoutubeMusicDiscoveryStore },
    { useLastfmStore },
    { useListenBrainzStore },
    { useActivityStore },
  ] = await Promise.all([
    import("./actions"),
    import("../stores/providerStore"),
    import("../backends/ytmusic/discovery"),
    import("../metadata/lastfm/authStore"),
    import("../metadata/listenbrainz/authStore"),
    import("../activity/store"),
    import("../stores/mixedPlaylistStore"),
    import("../stores/linkedPlaylistStore"),
    import("../stores/favoritesStore"),
    import("../backends/ytmusic/ratings"),
  ])
  const mixed = backgroundDomains.get("mixed")!
  mixed.store.setState({
    sync: (...args: any[]) =>
      rpc("invoke", "background_client_call", {
        request: {
          owner: context?.owner,
          domain: "mixed",
          method: "sync",
          args: workerData(args),
        },
      }),
  })
  const linked = backgroundDomains.get("linked")!
  linked.store.setState({
    matchIncomplete: (...args: any[]) =>
      rpc("invoke", "background_client_call", {
        request: {
          owner: context?.owner,
          domain: "linked",
          method: "matchIncomplete",
          args: workerData(args),
        },
      }),
  })
  let applying = false,
    timer: ReturnType<typeof setTimeout> | undefined
  const dirty = new Set<import("./actions").Domain>()
  const sent = new StateSnapshots()
  const running = new Map<string, { owner: string; domain: string; method: string }>()
  function progress(domain: string, method: string): Progress {
    if (domain === "favorites") {
      const activity =
        useActivityStore.getState().jobs[method === "matchMissing" ? "favorite-matching" : "favorite-sync"]?.activity
      return {
        stage: activity?.label ?? (method === "matchMissing" ? "Matching liked songs" : "Syncing liked songs"),
        current: activity?.detail,
        completed: activity?.progress?.value ?? 0,
        total: activity?.progress?.total,
        unit: activity?.progress?.label ?? "",
      }
    }
    if (domain === "ratings")
      return { stage: "Syncing song ratings", completed: 0, unit: "" }
    if (domain === "linked")
      return { stage: "Syncing ListenBrainz playlist", completed: 0, unit: "" }
    const mixed = backgroundDomains.get("mixed")?.store.getState()
    const playlist = mixed?.playlists.find(
      (item: any) => mixed.running[item.id]
    )
    if (playlist) {
      const checked = playlist.items.filter(
        (item: any) => item.match.status !== "pending"
      ).length
      const phase = mixed.phases[playlist.id]
      return {
        stage:
          phase?.kind === "preparing" ? "Preparing source playlists" : phase?.kind === "matching"
            ? "Matching songs and syncing verified matches"
            : "Syncing playlist",
        current: playlist.title,
        completed: checked,
        total: playlist.items.length,
        unit: "songs checked",
      }
    }
    return { stage: "Reconciling saved changes", completed: 0, unit: "" }
  }
  function flush() {
    clearTimeout(timer)
    timer = undefined
    if (!context) {
      dirty.clear()
      return
    }
    for (const domain of dirty) {
      const data = sent.take(
        domain,
        backgroundDomains.get(domain)!.store.getState()
      )
      if (data) post({ type: "state", owner: context.owner, domain, data })
    }
    dirty.clear()
    for (const [token, job] of running)
      if (
        job.owner === context.owner &&
        !["collections", "metadata"].includes(job.domain)
      )
        post({ type: "progress", token, progress: progress(job.domain, job.method) })
  }
  for (const [domain, { store }] of backgroundDomains)
    store.subscribe(() => {
      if (applying) return
      dirty.add(domain)
      if (!timer) timer = setTimeout(flush, 250)
    })
  useActivityStore.subscribe(() => {
    if (!timer && running.size) timer = setTimeout(flush, 250)
  })
  return async (message: ToWorker) => {
    if (message.type === "context") {
      const replaced = context?.owner !== message.context.owner
      if (replaced) sent.clear()
      context = message.context
      applying = true
      const info = context.provider
      if (info && replaced) {
        const expectedOwner = context.owner
        const provider: any = { ...info.data, playbackSession: context.owner }
        for (const method of info.methods)
          provider[method] = (...args: any[]) =>
            rpc("provider", method, args, expectedOwner)
        if (info.favorites)
          provider.favorites = Object.fromEntries(
            info.favorites.map((method) => [
              method,
              (...args: any[]) =>
                rpc("provider", `favorites.${method}`, args, expectedOwner),
            ])
          )
        useProviderStore.getState().setProvider(provider)
      } else if (!info && replaced) useProviderStore.getState().clearProvider()
      useYoutubeMusicDiscoveryStore.setState(context.youtube)
      useLastfmStore.setState(context.lastfm)
      useListenBrainzStore.setState(context.listenbrainz)
      applying = false
    } else if (message.type === "state" && message.owner === context?.owner) {
      const entry = backgroundDomains.get(message.domain)!
      const before = entry.store.getState(),
        next = message.data
      if (next.playlists)
        next.playlists = newestRows(before.playlists, next.playlists)
      if (next.links) next.links = newestRows(before.links, next.links)
      if (
        message.domain === "ratings" &&
        next.entries &&
        (next.owner === undefined || next.owner === before.owner)
      )
        next.entries = newestRatings(before.entries, next.entries)
      if (
        next.collection &&
        before.collection.revision > next.collection.revision
      ) {
        delete next.collection
        delete next.likedTrackIds
        delete next.ratingsByTrackId
      }
      // A UI load must not clear a running job's execution markers.
      delete next.running
      delete next.phases
      delete next.syncing
      if (message.domain === "favorites") {
        next.provider = useProviderStore.getState().provider
        next.session = next.provider?.playbackSession
      }
      applying = true
      try {
        entry.store.setState(next)
        sent.received(message.domain, before, entry.store.getState())
      } finally {
        applying = false
      }
    } else if (message.type === "run") {
      const { token, request } = message.job
      if (request.owner !== context?.owner) {
        post({ type: "finished", token, error: "Music accounts changed." })
        return
      }
      running.set(token, { owner: context.owner, domain: request.domain, method: request.method })
      const owner = context.owner
      try {
        const method = backgroundDomains.get(request.domain)?.methods[
          request.method
        ]
        if (!method && !["collections", "metadata"].includes(request.domain))
          throw Error("Unsupported background work")
        const args: any[] = [...request.args]
        if (request.domain === "linked") {
          if (args[1] == null) args[1] = undefined
          if (args[2])
            args[2] = {
              ...args[2],
              onMutation: () => post({ type: "mutated", token }),
            }
        }
        if (
          (request.method === "retryIndexedMatches" ||
            request.method === "retryPlexMatches") &&
          args[0]
        )
          args[0] = {
            ...(args[0] as object),
            provider: useProviderStore.getState().provider,
          }
        if (request.domain === "metadata")
          post({
            type: "progress",
            token,
            progress: {
              stage: "Refreshing saved library data",
              completed: 0,
              unit: "",
            },
          })
        const result =
          request.domain === "metadata"
            ? await rpc(
                "provider",
                `__metadata.${(args[0] as any).method}`,
                (args[0] as any).args
              )
            : request.domain === "collections" && request.method === "hydrateYoutubeMusic"
              ? await (await import("../offline/youtubePlaylistCache")).hydrateYoutubePlaylist(args[0], {
                  active: () => {
                    const state = useYoutubeMusicDiscoveryStore.getState()
                    const job = args[0]
                    return context?.owner === owner && state.connected && state.revision === job.owner.revision &&
                      state.accountId === job.owner.accountId
                  },
                  read: cursor => import("../backends/ytmusic/discovery").then(module =>
                    module.browseYoutubeMusic({ browseId: args[0].id }, cursor)),
                  progress: (completed, total) => post({ type: "progress", token,
                    progress: { stage: "Caching YTM playlist", current: args[0].title, completed, total, unit: "songs" } }),
                })
            : request.domain === "collections"
              ? await (
                  await import("../offline/hydrateCollection")
                ).hydrateCollection(args[0], {
                  native: (op, extra) =>
                    rpc("invoke", "collection_cache", {
                      context: args[0].context,
                      request: { op, key: args[0].key, ...extra },
                    }) as Promise<any>,
                  read: (method, values) =>
                    rpc("provider", `__collection.${method}`, values),
                  progress: (completed, total) =>
                    post({
                      type: "progress",
                      token,
                      progress: {
                        stage: "Caching Plex collection",
                        current: args[0].key,
                        completed,
                        total,
                        unit: "items",
                      },
                    }),
                })
              : await method!(...args)
        if (context?.owner !== owner) throw Error("Music accounts changed.")
        flush()
        post({ type: "finished", token, result: workerData(result) ?? null })
      } catch (error) {
        flush()
        post({
          type: "finished",
          token,
          error: String(error instanceof Error ? error.message : error),
          unexpected:
            error instanceof TypeError ||
            error instanceof ReferenceError ||
            error instanceof SyntaxError,
        })
      } finally {
        running.delete(token)
      }
    }
  }
})()

const runLanes = new Map<string, Promise<void>>()
scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data
  if (message.type === "reply") {
    const pending = replies.get(message.id)
    replies.delete(message.id)
    if (message.error) pending?.reject(Error(message.error))
    else pending?.resolve(message.value)
  } else if (message.type === "callback") {
    const handler = callbacks.get(message.id)
    if (handler?.once) callbacks.delete(message.id)
    handler?.callback(message.value)
  } else if (message.type === "run") {
    // Each domain owns separate journals/serialization. A long catalog lookup
    // must not hold up an unrelated rating or favorites update.
    const lane = message.job.request.domain
    const run = (runLanes.get(lane) ?? Promise.resolve())
      .catch(() => {})
      .then(() => ready.then((receive) => receive(message)))
    runLanes.set(lane, run)
    void run
      .finally(() => {
        if (runLanes.get(lane) === run) runLanes.delete(lane)
      })
      .catch((error) => post({ type: "fault", message: String(error) }))
  } else
    void ready
      .then((receive) => receive(message))
      .catch((error) => post({ type: "fault", message: String(error) }))
}
void ready
  .then(() => post({ type: "ready" }))
  .catch((error) => post({ type: "fault", message: String(error) }))
