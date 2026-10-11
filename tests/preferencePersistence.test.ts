import { expect, test } from "bun:test"
import { createStore } from "zustand/vanilla"
import {
  PreferencePersistence,
  type PreferenceBackend,
} from "../src/stores/preferencePersistence"
import { persistenceMiddleware } from "../src/stores/safePersist"
import {
  applyStatePatches,
  statePatches,
} from "../src/stores/persistencePatches"
import { deferred, settle } from "./helpers/radioAudioFakes"

class Backend implements PreferenceBackend {
  records = new Map<string, string>()
  readError = false
  writeError = false
  removeError = false
  reads = 0
  writes = 0
  readBarrier: ReturnType<typeof deferred<unknown>> | null = null
  writeBarrier: ReturnType<typeof deferred<void>> | null = null
  removeBarrier: ReturnType<typeof deferred<void>> | null = null
  private tail = Promise.resolve()
  get = (key: string) => {
    this.reads++
    if (this.readError) throw new Error("Storage unavailable")
    return this.readBarrier?.promise ?? this.records.get(key)
  }
  update = (key: string, transform: (current: unknown) => string) => {
    this.writes++
    const barrier = this.writeBarrier
    const operation = this.tail.then(async () => {
      if (barrier) await barrier.promise
      if (this.writeError) throw new Error("Quota exhausted")
      this.records.set(key, transform(this.records.get(key)))
    })
    this.tail = operation.catch(() => {})
    return operation
  }
  remove = async (key: string) => {
    if (this.removeBarrier) await this.removeBarrier.promise
    if (this.removeError) throw new Error("Could not remove record")
    this.records.delete(key)
  }
  save(key: string, state: any, extra: any = {}) {
    this.records.set(key, JSON.stringify({ version: 0, state, ...extra }))
  }
  state(key = "preferences") {
    return JSON.parse(this.records.get(key)!).state
  }
}
interface Preferences {
  favorites: { uuid: string; title: string }[]
  subscriptions: { feedUrl: string }[]
  progress: Record<string, Record<string, number>>
  completed: Record<string, string[]>
  priority: string[]
  toggle(id: string): void
  subscribe(feed: string): void
  position(feed: string, id: string, value: number): void
  complete(feed: string, id: string): void
  order(values: string[]): void
}
function store(
  service: PreferencePersistence,
  name = "preferences",
  finish?: (state: Preferences | undefined, error?: unknown) => void
) {
  const persist = persistenceMiddleware(service)
  return createStore<Preferences>()(
    persist(
      (set, get) => ({
        favorites: [],
        subscriptions: [],
        progress: {},
        completed: {},
        priority: ["plex"],
        toggle: (id) =>
          set((state) => ({
            favorites: state.favorites.some((value) => value.uuid === id)
              ? state.favorites.filter((value) => value.uuid !== id)
              : [...state.favorites, { uuid: id, title: id }],
          })),
        subscribe: (feed) =>
          set((state) => ({
            subscriptions: [...state.subscriptions, { feedUrl: feed }],
          })),
        position: (feed, id, value) =>
          set((state) => ({
            progress: {
              ...state.progress,
              [feed]: { ...state.progress[feed], [id]: value },
            },
          })),
        complete: (feed, id) =>
          set((state) => ({
            completed: {
              ...state.completed,
              [feed]: [...(state.completed[feed] ?? []), id],
            },
          })),
        order: (priority) => set({ priority }),
      }),
      {
        name,
        partialize: (state) => ({
          favorites: state.favorites,
          subscriptions: state.subscriptions,
          progress: state.progress,
          completed: state.completed,
          priority: state.priority,
        }),
        keyedArrays: {
          favorites: "uuid",
          subscriptions: "feedUrl",
          "completed.*": "$value",
        },
        validate: (saved) =>
          saved.favorites === undefined || Array.isArray(saved.favorites),
        onRehydrateStorage: () => finish,
      }
    )
  )
}
const saved = {
  favorites: [{ uuid: "old", title: "Saved" }],
  subscriptions: [{ feedUrl: "old-feed" }],
  progress: { feed: { old: 40 } },
  completed: { feed: ["old"] },
  priority: ["apple", "plex"],
  future: { retained: true },
}

async function hydrated(store: ReturnType<typeof store>) {
  await settle()
  expect(store.persist.hasHydrated()).toBe(true)
}

test("a failed read cannot turn defaults into a replacement for saved user data", async () => {
  const backend = new Backend()
  backend.save("preferences", saved)
  backend.readError = true
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  await settle()
  expect(() => prefs.getState().toggle("new")).not.toThrow()
  await settle()
  expect(backend.writes).toBe(0)
  expect(backend.state().favorites).toEqual(saved.favorites)
  expect(service.snapshot()).toEqual([
    { key: "preferences", operation: "read", hasPendingChanges: true },
  ])
  backend.readError = false
  await service.retry()
  await service.flush()
  expect(prefs.getState().favorites.map((value) => value.uuid)).toEqual([
    "new",
    "old",
  ])
  expect(backend.state().future).toEqual(saved.future)
  expect(backend.state().favorites.map((value: any) => value.uuid)).toEqual([
    "new",
    "old",
  ])
  expect(service.snapshot()).toEqual([])
})

test("a slow initial read merges new favorites, subscriptions, progress and completion", async () => {
  const backend = new Backend()
  backend.save("preferences", saved)
  backend.readBarrier = deferred()
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  prefs.getState().toggle("new")
  prefs.getState().subscribe("new-feed")
  prefs.getState().position("feed", "new", 25)
  prefs.getState().complete("feed", "new")
  prefs.getState().order(["plex", "apple"])
  expect(backend.writes).toBe(0)
  backend.readBarrier.resolve(backend.records.get("preferences"))
  await hydrated(prefs)
  await service.flush()
  expect(prefs.getState().favorites.map((value) => value.uuid)).toEqual([
    "new",
    "old",
  ])
  expect(prefs.getState().subscriptions.map((value) => value.feedUrl)).toEqual([
    "new-feed",
    "old-feed",
  ])
  expect(prefs.getState().progress.feed).toEqual({ old: 40, new: 25 })
  expect(prefs.getState().completed.feed).toEqual(["new", "old"])
  expect(prefs.getState().priority).toEqual(["plex", "apple"])
  expect(backend.state().future).toEqual({ retained: true })
})

test("local favorite removal during hydration preserves other unseen favorites", async () => {
  const backend = new Backend()
  backend.save("preferences", saved)
  backend.readBarrier = deferred()
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  prefs.getState().toggle("old")
  prefs.getState().toggle("old")
  backend.readBarrier.resolve(backend.records.get("preferences"))
  await hydrated(prefs)
  await service.flush()
  expect(prefs.getState().favorites).toEqual([])
  expect(backend.state().subscriptions).toEqual(saved.subscriptions)
})

test("an edit made while a write is in flight survives completion of that batch", async () => {
  const backend = new Backend()
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  await hydrated(prefs)
  backend.writeBarrier = deferred()
  prefs.getState().position("feed", "episode", 25)
  prefs.getState().position("feed", "episode", 50)
  prefs.getState().position("feed", "episode", 75)
  backend.writeBarrier.resolve()
  await service.flush()
  expect(backend.state().progress.feed.episode).toBe(75)
  expect(backend.writes).toBe(2)
})

test("failed writes retain changes and retry atomically against newer saved data", async () => {
  const backend = new Backend()
  backend.save("preferences", saved)
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  await hydrated(prefs)
  backend.writeError = true
  prefs.getState().toggle("new")
  await settle()
  const writes = backend.writes
  prefs.getState().toggle("old")
  prefs.getState().subscribe("new-feed")
  await settle()
  expect(backend.writes).toBe(writes)
  backend.save("preferences", {
    ...saved,
    favorites: [
      ...saved.favorites,
      { uuid: "external", title: "Other window" },
    ],
    future: { newer: true },
  })
  backend.writeError = false
  await service.retry()
  await service.flush()
  expect(backend.state().favorites.map((value: any) => value.uuid)).toEqual([
    "new",
    "external",
  ])
  expect(
    backend.state().subscriptions.map((value: any) => value.feedUrl)
  ).toEqual(["old-feed", "new-feed"])
  expect(backend.state().future).toEqual({ newer: true })
  expect(service.snapshot()).toEqual([])
})

test("two persistence owners update the same record without erasing unrelated changes", async () => {
  const backend = new Backend()
  backend.save("preferences", saved)
  const one = new PreferencePersistence(backend),
    two = new PreferencePersistence(backend)
  const first = store(one),
    second = store(two)
  await hydrated(first)
  await hydrated(second)
  first.getState().position("feed", "a", 20)
  second.getState().position("feed", "b", 30)
  await Promise.all([one.flush(), two.flush()])
  expect(backend.state().progress.feed).toEqual({ old: 40, a: 20, b: 30 })
})

test("malformed, unknown-version, and invalid preference rows remain untouched", async () => {
  for (const raw of [
    "broken JSON",
    JSON.stringify({ version: 3, state: saved }),
    JSON.stringify({ version: 0, state: { favorites: 5 } }),
  ]) {
    const backend = new Backend()
    backend.records.set("preferences", raw)
    const service = new PreferencePersistence(backend)
    const prefs = store(service)
    await settle()
    prefs.getState().toggle("new")
    await service.retry()
    await service.flush()
    expect(backend.records.get("preferences")).toBe(raw)
    expect(backend.writes).toBe(0)
    expect(service.snapshot()[0].operation).toBe("read")
  }
})

test("a failure in hydration repair cannot authorize writes from a partial state", async () => {
  const backend = new Backend()
  backend.save("preferences", saved)
  const service = new PreferencePersistence(backend)
  let fail = true
  const prefs = store(service, "preferences", () => {
    if (fail) throw new Error("Repair failed")
  })
  await settle()
  prefs.getState().toggle("new")
  await settle()
  expect(backend.writes).toBe(0)
  fail = false
  await service.retry()
  await service.flush()
  expect(backend.state().favorites.map((value: any) => value.uuid)).toEqual([
    "old",
    "new",
  ])
})

test("special JSON property names cannot pollute object prototypes", () => {
  const before = JSON.parse('{"progress":{}}')
  const after = JSON.parse(
    '{"progress":{"__proto__":{"polluted":25},"constructor":{"episode":50}}}'
  )
  const result = applyStatePatches(before, statePatches(before, after, {}))
  expect(({} as any).polluted).toBeUndefined()
  expect(Object.getPrototypeOf(result.progress)).toBe(Object.prototype)
  expect(JSON.parse(JSON.stringify(result)).progress.__proto__.polluted).toBe(
    25
  )
})

test("an obsolete read failure cannot replace a successful retry", async () => {
  const backend = new Backend()
  const oldRead = (backend.readBarrier = deferred())
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  backend.readBarrier = null
  backend.save("preferences", saved)
  await prefs.persist.rehydrate()
  prefs.getState().toggle("new")
  oldRead.reject(new Error("Old read failed"))
  await settle()
  await service.flush()
  expect(service.snapshot()).toEqual([])
  expect(backend.state().favorites.map((value: any) => value.uuid)).toEqual([
    "old",
    "new",
  ])
})

test("clearing a corrupt record fences startup and preserves edits during deletion", async () => {
  const backend = new Backend()
  const oldRead = (backend.readBarrier = deferred())
  backend.records.set("preferences", "broken JSON")
  backend.removeBarrier = deferred()
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  prefs.getState().toggle("discard")
  prefs.setState({ favorites: [] })
  prefs.persist.clearStorage()
  prefs.getState().toggle("keep")
  oldRead.resolve("broken JSON")
  await settle()
  expect(backend.writes).toBe(0)
  backend.removeBarrier.resolve()
  await service.flush()
  expect(prefs.getState().favorites.map((value) => value.uuid)).toEqual([
    "keep",
  ])
  expect(backend.state().favorites.map((value: any) => value.uuid)).toEqual([
    "keep",
  ])
  expect(service.snapshot()).toEqual([])
})

test("a failed clear retries deletion without losing later edits", async () => {
  const backend = new Backend()
  backend.save("preferences", saved)
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  await hydrated(prefs)
  backend.removeError = true
  prefs.setState({ favorites: [] })
  prefs.persist.clearStorage()
  await settle()
  prefs.getState().toggle("new")
  expect(service.snapshot()).toEqual([
    { key: "preferences", operation: "remove", hasPendingChanges: true },
  ])
  backend.removeError = false
  await service.retry()
  await service.flush()
  expect(backend.state().favorites.map((value: any) => value.uuid)).toEqual([
    "new",
  ])
  expect(service.snapshot()).toEqual([])
})

test("a failed accepted write cannot restore edits discarded by an explicit clear", async () => {
  const backend = new Backend()
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  await hydrated(prefs)
  backend.writeBarrier = deferred()
  backend.writeError = true
  prefs.getState().toggle("discard")
  prefs.setState({ favorites: [] })
  prefs.persist.clearStorage()
  prefs.getState().toggle("keep")
  backend.writeBarrier.resolve()
  await settle()
  backend.writeBarrier = null
  backend.writeError = false
  await service.retry()
  await service.flush()
  expect(backend.state().favorites.map((value: any) => value.uuid)).toEqual([
    "keep",
  ])
})

test("replacing a store owner waits for its accepted write and keeps queued edits", async () => {
  const backend = new Backend()
  const service = new PreferencePersistence(backend)
  const first = store(service)
  await hydrated(first)
  backend.writeBarrier = deferred()
  first.getState().toggle("accepted")
  first.getState().toggle("queued")
  const replacement = store(service)
  replacement.getState().toggle("replacement")
  first.getState().toggle("obsolete")
  const ready = new Promise<void>((resolve) =>
    replacement.persist.onFinishHydration(() => resolve())
  )
  backend.writeBarrier.resolve()
  await ready
  await service.flush()
  expect(backend.state().favorites.map((value: any) => value.uuid)).toEqual([
    "replacement",
    "accepted",
    "queued",
  ])
  expect(service.snapshot()).toEqual([])
})

test("unknown saved fields stay on disk without replacing store actions", async () => {
  const backend = new Backend()
  backend.save("preferences", {
    ...saved,
    toggle: "not an action",
    future: { retained: true },
  })
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  await hydrated(prefs)
  expect(() => prefs.getState().toggle("new")).not.toThrow()
  expect((prefs.getState() as any).future).toBeUndefined()
  await service.flush()
  expect(backend.state().toggle).toBe("not an action")
  expect(backend.state().future).toEqual({ retained: true })
})

test("invalid saved dictionary fields are protected before store actions can use them", async () => {
  const backend = new Backend()
  backend.save("preferences", { ...saved, progress: "invalid" })
  const raw = backend.records.get("preferences")
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  await settle()
  prefs.getState().position("feed", "episode", 25)
  await service.flush()
  expect(backend.records.get("preferences")).toBe(raw)
  expect(backend.writes).toBe(0)
  expect(service.snapshot()[0].operation).toBe("read")
})

test("shutdown waits for pending hydration edits to be retained", async () => {
  const backend = new Backend()
  backend.save("preferences", saved)
  backend.readBarrier = deferred()
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  prefs.getState().toggle("close-pending")
  let finished = false
  const flush = service.flushForShutdown().then(() => { finished = true })
  await settle()
  expect(finished).toBe(false)
  backend.readBarrier.resolve(backend.records.get("preferences"))
  await flush
  expect(backend.state().favorites.some((item: any) => item.uuid === "close-pending")).toBe(true)
})

test("failed local retention rejects shutdown and preserves edits for retry", async () => {
  const backend = new Backend()
  backend.save("preferences", saved)
  const service = new PreferencePersistence(backend)
  const prefs = store(service)
  await hydrated(prefs)
  backend.writeError = true
  prefs.getState().toggle("unsaved-listener-choice")
  await expect(service.flushForShutdown()).rejects.toThrow("could not be saved")
  expect(service.snapshot().some(issue => issue.hasPendingChanges)).toBe(true)
  backend.writeError = false
  await service.flushForShutdown()
  expect(backend.state().favorites.some((item: any) => item.uuid === "unsaved-listener-choice")).toBe(true)
})

test("shutdown protects explicit default intents that create no pre-hydration patch", async () => {
  const backend = new Backend()
  backend.save("choice", { enabled: true })
  backend.readError = true
  const service = new PreferencePersistence(backend)
  let hydratedChoice = false, intent = false
  const persist = persistenceMiddleware(service)
  const prefs = createStore<{ enabled: boolean; disable(): void }>()(persist((set) => ({
    enabled: false,
    disable: () => { if (!hydratedChoice) intent = true; set({ enabled: false }) },
  }), {
    name: "choice",
    partialize: state => ({ enabled: state.enabled }),
    hasPendingIntent: () => intent,
    onRehydrateStorage: () => { hydratedChoice = false; return (state, error) => {
      if (!state || error) return
      if (intent) { prefs.setState({ enabled: false }); intent = false }
      hydratedChoice = true
    } },
  }))
  await settle()
  prefs.getState().disable()
  await expect(service.flushForShutdown()).rejects.toThrow("could not be saved")
  expect(service.snapshot()[0].hasPendingChanges).toBe(true)
  backend.readError = false
  await service.flushForShutdown()
  expect(backend.state("choice").enabled).toBe(false)
})
