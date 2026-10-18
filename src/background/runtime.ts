import { collectionBackgroundProvider } from "../offline/collectionCache"
import { useLayoutEffect } from "react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import {
  backgroundDomains,
  setBackgroundDispatcher,
  type Call,
} from "./actions"
import {
  newestRatings,
  newestRows,
  StateSnapshots,
  PendingCalls,
  workerData,
  type FromWorker,
  type Job,
  type ProviderDescription,
  type ToWorker,
  type WorkerContext,
} from "./protocol"
import { useProviderStore } from "../stores/providerStore"
import { useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"
import { useLastfmStore } from "../metadata/lastfm/authStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import {
  backgroundMetadataRead,
  freshPlaylistReads,
} from "../offline/providerCache"
import { useLibraryStore } from "../stores/libraryStore"

function methods(value: object): string[] {
  const keys = new Set<string>()
  for (
    let current = value;
    current && current !== Object.prototype;
    current = Object.getPrototypeOf(current)
  )
    for (const key of Object.getOwnPropertyNames(current))
      if (key !== "constructor" && typeof (value as any)[key] === "function")
        keys.add(key)
  return [...keys]
}
function describe(
  provider: ReturnType<typeof useProviderStore.getState>["provider"]
): ProviderDescription | null {
  if (!provider) return null
  return {
    data: {
      name: provider.name,
      capabilities: provider.capabilities,
      cacheScope: provider.cacheScope,
      isOffline: provider.isOffline,
    },
    methods: [...methods(provider), "__playlistVerified"],
    favorites: provider.favorites ? methods(provider.favorites) : undefined,
  }
}
function auth(
  state:
    | ReturnType<typeof useLastfmStore.getState>
    | ReturnType<typeof useListenBrainzStore.getState>
) {
  return {
    isAuthenticated: state.isAuthenticated,
    isEnabled: state.isEnabled,
    username: state.username,
  }
}
export function startBackgroundWorker() {
  if (!isTauri() || typeof Worker === "undefined") return () => {}
  let worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "hibiki-reconciliation",
  })
  let active = true,
    publishing = false,
    owner = "",
    binding = "",
    metadata = "",
    provider = useProviderStore.getState().provider
  let session = provider?.playbackSession,
    started = false
  const listeners = new Map<number, UnlistenFn>(),
    tokens = new Set<string>(),
    stops: (() => void)[] = []
  const mutationWaiters = new Map<string, Set<() => void>>(),
    mutationTokens = new Map<string, Set<() => void>>()
  const requestKey = (request: Call & { owner: string }) =>
    JSON.stringify([
      request.owner,
      request.domain,
      request.method,
      request.args,
    ])
  let eventSequence = 0,
    failure: Error | undefined
  let resolveReady: () => void, rejectReady: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  void ready.catch(() => {})
  const post = (message: ToWorker) => {
    if (active) worker.postMessage(message)
  }
  const sent = new StateSnapshots()
  const admissions = new PendingCalls()
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined
  function snapshots() {
    clearTimeout(snapshotTimer)
    snapshotTimer = undefined
    for (const [domain, { store }] of backgroundDomains) {
      const data = sent.take(domain, store.getState())
      if (data) post({ type: "state", owner, domain, data })
    }
  }
  let bound: Promise<unknown> = Promise.resolve()
  function context() {
    const current = useProviderStore.getState().provider,
      yt = useYoutubeMusicDiscoveryStore.getState()
    const lastfm = auth(useLastfmStore.getState()),
      listenbrainz = auth(useListenBrainzStore.getState())
    // Session/owner changes retire jobs. Routine metadata, enabled flags and
    // catalog revisions propagate without replacing an unchanged Plex proxy.
    const key = JSON.stringify([
      current?.cacheScope,
      current?.isOffline,
      yt.connected,
      yt.accountId,
      lastfm.isAuthenticated,
      lastfm.username,
      listenbrainz.isAuthenticated,
      listenbrainz.username,
    ])
    const details = JSON.stringify([
      key,
      yt.revision,
      lastfm.isEnabled,
      listenbrainz.isEnabled,
    ])
    const replaced =
      binding !== key ||
      provider !== current ||
      session !== current?.playbackSession
    if (!replaced && details === metadata) return
    provider = current
    session = current?.playbackSession
    binding = key
    metadata = details
    if (replaced || !owner) {
      sent.clear()
      if (owner) {
        // No old async continuation may borrow a newly bound provider. Its
        // journal was already retained; the next owner resumes by verification.
        const previous = worker
        worker = new Worker(new URL("./worker.ts", import.meta.url), {
          type: "module",
          name: "hibiki-reconciliation",
        })
        worker.onmessage = previous.onmessage
        worker.onerror = previous.onerror
        worker.onmessageerror = previous.onmessageerror
        previous.terminate()
        tokens.clear()
        mutationTokens.clear()
        for (const detach of listeners.values()) detach()
        listeners.clear()
      }
      owner = crypto.randomUUID()
      bound = invoke("background_client_owner", { owner })
    }
    const value: WorkerContext = {
      owner,
      provider: describe(current),
      youtube: {
        connected: yt.connected,
        accountId: yt.accountId,
        revision: yt.revision,
      },
      lastfm,
      listenbrainz,
    }
    post({ type: "context", context: value })
    snapshots()
  }
  async function execute(call: Call) {
    await ready
    if (!active || failure) throw failure ?? Error("Background worker stopped")
    context()
    const expected = owner
    await bound
    if (expected !== owner) throw Error("Music accounts changed.")
    const request = {
      domain: call.domain,
      method: call.method,
      args: workerData(call.args),
      owner,
    }
    const key = requestKey(request),
      callbacks = mutationWaiters.get(key) ?? new Set<() => void>()
    if (call.onMutation) {
      callbacks.add(call.onMutation)
      mutationWaiters.set(key, callbacks)
    }
    try {
      const result = await admissions.run(key, () => invoke("background_client_call", { request }))
      if (expected !== owner) throw Error("Music accounts changed.")
      return result
    } finally {
      if (call.onMutation) {
        callbacks.delete(call.onMutation)
        if (!callbacks.size) mutationWaiters.delete(key)
      }
    }
  }
  function fail(error: Error) {
    failure = error
    rejectReady(error)
    for (const token of tokens)
      void invoke("background_client_signal", {
        token,
        signal: { type: "failed", message: error.message, unexpected: true },
      }).catch(() => {})
    tokens.clear()
  }
  worker.onerror = (event) => {
    if (event.currentTarget === worker)
      fail(Error(`Background worker failed: ${event.message}`))
  }
  worker.onmessageerror = (event) => {
    if (event.currentTarget === worker)
      fail(Error("Background worker could not read its message"))
  }
  worker.onmessage = async (event: MessageEvent<FromWorker>) => {
    // DOM Event.currentTarget becomes null after this callback yields. Capture
    // the sender now so asynchronous RPC can still verify its worker identity.
    const source = event.currentTarget
    const message = event.data
    if (!active || source !== worker) return
    if (message.type === "ready") {
      started = true
      context()
      resolveReady()
    } else if (message.type === "fault") fail(Error(message.message))
    else if (message.type === "rpc") {
      try {
        if (message.owner !== owner) throw Error("Music accounts changed.")
        let value: unknown
        if (message.kind === "provider") {
          if (!provider) throw Error("Plex is disconnected")
          if (message.method === "__playlistVerified")
            value = useLibraryStore
              .getState()
              .onPlaylistSyncVerified(
                ...(message.args as [string, number, string?])
              )
          else {
            if (message.method.startsWith("__metadata.")) {
              const method = message.method.slice(11)
              if (!backgroundMetadataRead(method))
                throw Error("Unsupported metadata read")
              value = await (collectionBackgroundProvider(provider) as any)[
                method
              ](...message.args)
            } else if (message.method.startsWith("__collection.")) {
              const method = message.method.slice(13)
              if (
                ![
                  "getPlaylists",
                  "getPlaylistItems",
                  "getRatedItemsPage",
                  "getMixTracksPage",
                ].includes(method)
              )
                throw Error("Unsupported collection read")
              value = await (collectionBackgroundProvider(provider) as any)[
                method
              ](...message.args)
            } else {
              const path = message.method.split(".")
              const source =
                path[0] === "favorites"
                  ? provider.favorites
                  : ["getPlaylists", "getPlaylistItems"].includes(path[0])
                    ? freshPlaylistReads(provider)
                    : provider
              const method = path.at(-1)!
              if (!source || !methods(source).includes(method))
                throw Error("Unsupported provider operation")
              value = await (source as any)[method](...message.args)
            }
          }
        } else if (message.method === "plugin:event|listen") {
          const id = ++eventSequence
          const detach = await listen(message.args.event, (value) => {
            if (message.owner === owner)
              post({ type: "callback", id: message.args.handler, value })
          })
          if (!active || message.owner !== owner) detach()
          else listeners.set(id, detach)
          value = id
        } else if (message.method === "plugin:event|unlisten") {
          listeners.get(message.args.eventId)?.()
          listeners.delete(message.args.eventId)
          value = null
        } else value = await invoke(message.method, message.args)
        // An old RPC can finish after its worker has been replaced. Callback
        // numbers restart in the new worker, so never deliver an old reply there.
        if (!active || source !== worker || message.owner !== owner) return
        post({ type: "reply", id: message.id, value })
      } catch (error) {
        if (!active || source !== worker || message.owner !== owner) return
        post({
          type: "reply",
          id: message.id,
          error: String(error instanceof Error ? error.message : error),
        })
      }
    } else if (message.type === "state" && message.owner === owner) {
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
      if (message.domain === "favorites") {
        next.provider = provider
        next.session = session
      }
      if (next.syncing)
        next.syncing = Object.fromEntries(
          Object.keys(next.syncing).map((id) => [
            id,
            { current: () => active && owner === message.owner },
          ])
        )
      publishing = true
      try {
        entry.store.setState(next)
        sent.received(message.domain, before, entry.store.getState())
      } finally {
        publishing = false
      }
    } else if (message.type === "mutated") {
      for (const notify of mutationTokens.get(message.token) ?? []) notify()
    } else if (message.type === "progress" || message.type === "finished") {
      if (message.type === "finished") {
        tokens.delete(message.token)
        mutationTokens.delete(message.token)
      }
      const signal =
        message.type === "progress"
          ? { type: "progress", progress: message.progress }
          : message.error
            ? {
                type: "failed",
                message: message.error,
                unexpected: message.unexpected ?? false,
              }
            : { type: "finished", result: message.result ?? null }
      void invoke("background_client_signal", {
        token: message.token,
        signal,
      }).catch(() => {})
    }
  }
  const attached = listen<Job>("background://client", (event) => {
    const job = event.payload
    if (!active || job.request.owner !== owner || tokens.has(job.token)) return
    if (failure) {
      void invoke("background_client_signal", {
        token: job.token,
        signal: { type: "failed", message: failure.message, unexpected: true },
      })
      return
    }
    tokens.add(job.token)
    const callbacks = mutationWaiters.get(requestKey(job.request))
    if (callbacks) mutationTokens.set(job.token, callbacks)
    snapshots()
    post({ type: "run", job })
  })
  void attached.catch((error) => fail(Error(String(error))))
  // Register immediately; initialization is awaited by every accepted call.
  setBackgroundDispatcher(async (call) => {
    await attached
    return execute(call)
  })
  for (const store of [
    useProviderStore,
    useYoutubeMusicDiscoveryStore,
    useLastfmStore,
    useListenBrainzStore,
  ])
    stops.push(
      store.subscribe(() => {
        if (started) context()
      })
    )
  for (const { store } of backgroundDomains.values())
    stops.push(
      store.subscribe(() => {
        if (started && !publishing && !snapshotTimer)
          snapshotTimer = setTimeout(snapshots, 50)
      })
    )
  return () => {
    active = false
    clearTimeout(snapshotTimer)
    rejectReady(Error("Background worker stopped"))
    setBackgroundDispatcher(undefined)
    for (const stop of stops) stop()
    for (const detach of listeners.values()) detach()
    void attached.then((detach) => detach()).catch(() => {})
    void invoke("background_client_owner", {
      owner: null,
      expectedOwner: owner,
    }).catch(() => {})
    worker.terminate()
  }
}
export function useBackgroundWorker() {
  useLayoutEffect(startBackgroundWorker, [])
}
