import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { resolve } from "node:path"
import { PreferencePersistence } from "../src/stores/preferencePersistence"
import { persistenceMiddleware } from "../src/stores/safePersist"
import { deferred, settle } from "./helpers/radioAudioFakes"

const dom = new JSDOM("", { url: "https://hibiki.example.test" })
const previous = {
  document: globalThis.document,
  window: globalThis.window,
  storage: globalThis.localStorage,
  timeout: globalThis.setTimeout,
  clear: globalThis.clearTimeout,
}
globalThis.document = dom.window.document
globalThis.window = dom.window as unknown as Window & typeof globalThis
globalThis.localStorage = dom.window.localStorage
const { createLyricsOffsetStore } =
  await import("../src/stores/lyricsOffsetStore")
const { createVisualizerStore } = await import("../src/stores/visualizerStore")
const { createSleepTimerStore } = await import("../src/stores/sleepTimerStore")
const { createCustomColorStore } =
  await import("../src/stores/customColorStore")
const { createEasterEggStore } = await import("../src/stores/easterEggStore")
const player = { getState: () => ({ pause() {}, refreshPreload() {} }) }
const cases = [
  {
    key: "plex-lyrics-offsets",
    create: createLyricsOffsetStore,
    saved: { offsets: { saved: 500, untouched: -750 } },
    invalid: { offsets: { saved: "broken" } },
    mutate: (store: any) => {
      store.setState({ _trackId: "local" })
      store.getState().setOffset(1000)
    },
    verify: (state: any) =>
      expect(state.offsets).toEqual({
        saved: 500,
        untouched: -750,
        local: 1000,
      }),
  },
  {
    key: "plex-visualizer-v1",
    create: createVisualizerStore,
    saved: {
      compactMode: "spectrum",
      favoritePresets: ["Saved"],
      presetHistory: ["Old"],
      autoCycleMode: "sequential",
    },
    invalid: { favoritePresets: [42] },
    mutate: (store: any) => store.getState().toggleFavorite("New"),
    verify: (state: any) => {
      expect([...state.favoritePresets].sort()).toEqual(["New", "Saved"])
      expect(state.compactMode).toBe("spectrum")
      expect(state.presetHistory).toEqual(["Old"])
    },
  },
  {
    key: "plex-sleep-timer-v1",
    create: (persist: ReturnType<typeof persistenceMiddleware>) =>
      createSleepTimerStore(persist, player),
    saved: { endsAt: null, endOfTrack: false },
    invalid: { endsAt: "tomorrow" },
    mutate: (store: any) => store.getState().startEndOfTrack(),
    verify: (state: any) => {
      expect(state.endOfTrack).toBe(true)
      expect(state.endsAt).toBeNull()
    },
  },
  {
    key: "plex-custom-colors",
    create: createCustomColorStore,
    saved: {
      enabled: true,
      overrides: { "bg-base": "#123456", "text-primary": "#abcdef" },
    },
    invalid: { overrides: { "bg-base": [] } },
    mutate: (store: any) =>
      store.getState().setOverride("bg-elevated", "#654321"),
    verify: (state: any) => {
      expect(state.enabled).toBe(true)
      expect(state.overrides).toEqual({
        "bg-base": "#123456",
        "text-primary": "#abcdef",
        "bg-elevated": "#654321",
      })
    },
  },
  {
    key: "easter-eggs-v1",
    create: createEasterEggStore,
    saved: {
      rainbow: true,
      partyMode: true,
      vinylSpin: false,
      vaporwave: false,
    },
    invalid: { rainbow: "yes" },
    mutate: (store: any) => store.getState().toggleVinylSpin(),
    verify: (state: any) => {
      expect(state.rainbow).toBe(true)
      expect(state.partyMode).toBe(true)
      expect(state.vinylSpin).toBe(true)
    },
  },
]
function fixture(saved: unknown) {
  let raw = JSON.stringify({
    version: 0,
    state: { ...(saved as object), futurePreference: "preserve" },
  })
  let failRead = false
  let failWrite = false
  let delayedRead: Promise<unknown> | null = null
  const service = new PreferencePersistence({
    get: () => {
      if (failRead) throw new Error("access denied")
      return delayedRead ?? raw
    },
    update: (_key, transform) => {
      if (failWrite) throw new Error("quota exhausted")
      raw = transform(raw)
    },
    remove: () => {},
  })
  return {
    service,
    persist: persistenceMiddleware(service),
    raw: () => raw,
    state: () => JSON.parse(raw).state,
    readFailure: (value: boolean) => {
      failRead = value
    },
    writeFailure: (value: boolean) => {
      failWrite = value
    },
    delayRead: (value: Promise<unknown>) => {
      delayedRead = value
    },
    setRaw: (value: string) => {
      raw = value
    },
  }
}
beforeEach(() => {
  globalThis.document = dom.window.document
  document.documentElement.removeAttribute("style")
})
afterEach(() => {
  globalThis.setTimeout = previous.timeout
  globalThis.clearTimeout = previous.clear
})
afterAll(() => {
  globalThis.document = previous.document
  globalThis.window = previous.window
  globalThis.localStorage = previous.storage
  dom.window.close()
})

for (const item of cases) {
  test(`${item.key}: failed reads protect the saved blob while edits merge after retry`, async () => {
    const environment = fixture(item.saved)
    const original = environment.raw()
    environment.readFailure(true)
    const store = item.create(environment.persist)
    await settle()
    item.mutate(store)
    await settle()
    expect(environment.raw()).toBe(original)
    expect(environment.service.snapshot()).toEqual([
      { key: item.key, operation: "read", hasPendingChanges: true },
    ])
    environment.readFailure(false)
    await environment.service.retry()
    await environment.service.flush()
    item.verify(store.getState())
    item.verify(environment.state())
    expect(environment.state().futurePreference).toBe("preserve")
    expect(environment.service.snapshot()).toEqual([])
  })
  test(`${item.key}: failed writes expose a retryable notice and keep accepted edits`, async () => {
    const environment = fixture(item.saved)
    const store = item.create(environment.persist)
    await settle()
    const original = environment.raw()
    environment.writeFailure(true)
    item.mutate(store)
    await settle()
    expect(environment.raw()).toBe(original)
    expect(environment.service.snapshot()).toEqual([
      { key: item.key, operation: "write", hasPendingChanges: true },
    ])
    environment.writeFailure(false)
    await environment.service.retry()
    item.verify(environment.state())
    expect(environment.service.snapshot()).toEqual([])
  })
  test(`${item.key}: malformed JSON and nested preferences remain untouched after actions`, async () => {
    for (const raw of [
      "{broken",
      JSON.stringify({ state: item.invalid, version: 0 }),
    ]) {
      const environment = fixture(item.saved)
      environment.setRaw(raw)
      const store = item.create(environment.persist)
      await settle()
      item.mutate(store)
      await settle()
      await environment.service.retry()
      expect(environment.raw()).toBe(raw)
      expect(environment.service.snapshot()[0]?.operation).toBe("read")
    }
  })
}

test("lyrics offsets derive the already selected track after delayed hydration", async () => {
  const environment = fixture({ offsets: { selected: -2000 } })
  const reading = deferred<unknown>()
  environment.delayRead(reading.promise)
  const store = createLyricsOffsetStore(environment.persist)
  store.setState({ _trackId: "selected" })
  expect(store.getState().offsetMs).toBe(0)
  reading.resolve(environment.raw())
  await settle()
  expect(store.getState().offsetMs).toBe(-2000)
})
test("custom colors apply restored preferences after hydration and after read recovery", async () => {
  const environment = fixture({
    enabled: true,
    overrides: { "bg-base": "#123456" },
  })
  environment.readFailure(true)
  createCustomColorStore(environment.persist)
  await settle()
  expect(document.documentElement.style.getPropertyValue("--bg-base")).toBe("")
  environment.readFailure(false)
  await environment.service.retry()
  expect(document.documentElement.style.getPropertyValue("--bg-base")).toBe(
    "#123456"
  )
})
test("a future sleep timer schedules after delayed hydration and pauses exactly once", async () => {
  const callbacks = new Map<number, () => void>()
  const delays: number[] = []
  let nextId = 0
  let pauses = 0
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    delays.push(delay)
    callbacks.set(++nextId, callback)
    return nextId
  }) as any
  globalThis.clearTimeout = ((id: number) => callbacks.delete(id)) as any
  const environment = fixture({
    endsAt: Date.now() + 60_000,
    endOfTrack: false,
  })
  const reading = deferred<unknown>()
  environment.delayRead(reading.promise)
  const store = createSleepTimerStore(environment.persist, {
    getState: () => ({
      pause: () => {
        pauses++
      },
      refreshPreload() {},
    }),
  })
  store.getState().hydrate() // App mounts before asynchronous preferences arrive.
  expect(callbacks.size).toBe(0)
  reading.resolve(environment.raw())
  await settle()
  expect(callbacks.size).toBe(1)
  expect(delays[0]).toBeGreaterThan(59_000)
  store.getState().hydrate()
  expect(callbacks.size).toBe(1)
  const callback = [...callbacks.values()][0]
  callbacks.clear()
  callback()
  await environment.service.flush()
  expect(pauses).toBe(1)
  expect(store.getState().endsAt).toBeNull()
  expect(environment.state().endsAt).toBeNull()
})
test("expired sleep timers clear after restoration without pausing playback", async () => {
  let pauses = 0
  const environment = fixture({
    endsAt: Date.now() - 60_000,
    endOfTrack: false,
  })
  const store = createSleepTimerStore(environment.persist, {
    getState: () => ({
      pause: () => {
        pauses++
      },
      refreshPreload() {},
    }),
  })
  await settle()
  await environment.service.flush()
  expect(store.getState().endsAt).toBeNull()
  expect(environment.state().endsAt).toBeNull()
  expect(pauses).toBe(0)
})

test("lyrics Reset before a failed read recovers deletes only the selected saved offset", async () => {
  const environment = fixture({ offsets: { selected: 1200, untouched: 500 } })
  environment.readFailure(true)
  const store = createLyricsOffsetStore(environment.persist)
  await settle()
  store.setState({ _trackId: "selected" })
  store.getState().resetOffset()
  environment.readFailure(false)
  await environment.service.retry()
  await environment.service.flush()
  expect(store.getState().offsetMs).toBe(0)
  expect(environment.state().offsets).toEqual({ untouched: 500 })
})
test("cancel and end-of-track selections before recovery supersede an unseen saved timed timer", async () => {
  const callbacks = new Map<number, () => void>()
  let nextId = 0
  globalThis.setTimeout = ((callback: () => void) => {
    callbacks.set(++nextId, callback)
    return nextId
  }) as any
  globalThis.clearTimeout = ((id: number) => callbacks.delete(id)) as any
  for (const selection of ["cancel", "startEndOfTrack"] as const) {
    const environment = fixture({
      endsAt: Date.now() + 60_000,
      endOfTrack: false,
    })
    environment.readFailure(true)
    const store = createSleepTimerStore(environment.persist, player)
    await settle()
    store.getState()[selection]()
    environment.readFailure(false)
    await environment.service.retry()
    await environment.service.flush()
    expect(environment.state().endsAt).toBeNull()
    expect(environment.state().endOfTrack).toBe(selection === "startEndOfTrack")
    expect(callbacks.size).toBe(0)
  }
})
test("a timed selection before read recovery clears an unseen saved end-of-track flag", async () => {
  const callbacks = new Map<number, () => void>()
  let nextId = 0
  globalThis.setTimeout = ((callback: () => void) => {
    callbacks.set(++nextId, callback)
    return nextId
  }) as any
  globalThis.clearTimeout = ((id: number) => callbacks.delete(id)) as any
  const environment = fixture({ endsAt: null, endOfTrack: true })
  environment.readFailure(true)
  const store = createSleepTimerStore(environment.persist, player)
  await settle()
  store.getState().start(5)
  environment.readFailure(false)
  await environment.service.retry()
  await environment.service.flush()
  expect(environment.state().endOfTrack).toBe(false)
  expect(environment.state().endsAt).toBeGreaterThan(Date.now())
  expect(callbacks.size).toBe(1)
  store.getState().cancel()
})
test("color disable, override removal, and Reset before recovery retain explicit intent", async () => {
  for (const action of ["disable", "remove", "reset"]) {
    const environment = fixture({
      enabled: true,
      overrides: { "bg-base": "#123456", "text-primary": "#abcdef" },
    })
    environment.readFailure(true)
    const store = createCustomColorStore(environment.persist)
    await settle()
    if (action === "disable") store.getState().setEnabled(false)
    if (action === "remove") store.getState().setOverride("bg-base", null)
    if (action === "reset") store.getState().resetAll()
    environment.readFailure(false)
    await environment.service.retry()
    await environment.service.flush()
    expect(environment.state().enabled).toBe(action === "remove")
    expect(environment.state().overrides).toEqual(
      action === "reset"
        ? {}
        : action === "remove"
          ? { "text-primary": "#abcdef" }
          : { "bg-base": "#123456", "text-primary": "#abcdef" }
    )
    expect(document.documentElement.style.getPropertyValue("--bg-base")).toBe(
      ""
    )
  }
})
test("explicit default visualizer selection before read recovery overrides the unseen saved selection", async () => {
  const environment = fixture({ compactMode: "spectrum", fullscreenMode: "vu" })
  environment.readFailure(true)
  const store = createVisualizerStore(environment.persist)
  await settle()
  store.getState().setCompactMode("waveform")
  environment.readFailure(false)
  await environment.service.retry()
  await environment.service.flush()
  expect(environment.state().compactMode).toBe("waveform")
  expect(store.getState().fullscreenMode).toBe("vu")
})
test("a visual toggle enabled then disabled before recovery stays disabled", async () => {
  const environment = fixture({ rainbow: true, partyMode: true })
  environment.readFailure(true)
  const store = createEasterEggStore(environment.persist)
  await settle()
  store.getState().toggleRainbow()
  store.getState().toggleRainbow()
  environment.readFailure(false)
  await environment.service.retry()
  await environment.service.flush()
  expect(environment.state().rainbow).toBe(false)
  expect(store.getState().partyMode).toBe(true)
})
test("preset selection before recovery retains saved history and its 50-item cap", async () => {
  const history = Array.from({ length: 50 }, (_, index) => `Saved-${index}`)
  const environment = fixture({
    currentPresetName: "Saved-0",
    presetHistory: history,
  })
  environment.readFailure(true)
  const store = createVisualizerStore(environment.persist)
  await settle()
  store.getState().setCurrentPreset("New")
  environment.readFailure(false)
  await environment.service.retry()
  await environment.service.flush()
  expect(store.getState().currentPresetName).toBe("New")
  expect(store.getState().presetHistory).toEqual([
    "New",
    ...history.slice(0, 49),
  ])
  expect(environment.state().presetHistory).toEqual([
    "New",
    ...history.slice(0, 49),
  ])
})
test("migrated SQLite preferences restore all five singleton stores on startup", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { JSDOM } from "jsdom";
    const dom = new JSDOM("", { url: "https://hibiki.example.test" });
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    globalThis.localStorage = dom.window.localStorage;
    const saved = {
      "plex-lyrics-offsets": { offsets: { track: 1200 } },
      "plex-visualizer-v1": { compactMode: "spectrum", favoritePresets: ["Saved"] },
      "plex-sleep-timer-v1": { endsAt: null, endOfTrack: true },
      "plex-custom-colors": { enabled: true, overrides: { "bg-base": "#123456" } },
      "easter-eggs-v1": { rainbow: true, partyMode: true },
    };
    const { clientStorage, initializeClientStorage } = await import("./src/storage/clientStorage");
    const { localStore } = await import("./src/storage/keyValue");
    for (const [key, state] of Object.entries(saved)) await clientStorage.set(key, JSON.stringify({ state, version: 0 }), localStore);
    await initializeClientStorage();
    const { useLyricsOffsetStore: lyrics } = await import("./src/stores/lyricsOffsetStore");
    const { useVisualizerStore: viz } = await import("./src/stores/visualizerStore");
    const { useSleepTimerStore: sleep } = await import("./src/stores/sleepTimerStore");
    const { useCustomColorStore: colors } = await import("./src/stores/customColorStore");
    const { useEasterEggStore: eggs } = await import("./src/stores/easterEggStore");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(lyrics.getState().offsets, { track: 1200 });
    assert.equal(viz.getState().compactMode, "spectrum");
    assert.deepEqual(viz.getState().favoritePresets, ["Saved"]);
    assert.equal(sleep.getState().endOfTrack, true);
    assert.equal(colors.getState().enabled, true);
    assert.equal(document.documentElement.style.getPropertyValue("--bg-base"), "#123456");
    assert.equal(eggs.getState().rainbow, true);
    assert.equal(eggs.getState().partyMode, true);
    const { localPreferencePersistence } = await import("./src/stores/localPreferenceStorage");
    await localPreferencePersistence.flush();
    for (const key of Object.keys(saved)) assert.notEqual(await clientStorage.get(key, localStore), undefined);
    console.log("Local preferences restored");
    dom.window.close();
  `
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ status, errors }).toEqual({ status: 0, errors: "" })
  expect(output.trim()).toBe("Local preferences restored")
})
test("restoring a cleared timer cancels a timeout from the previous hydrated state", async () => {
  const callbacks = new Map<number, () => void>()
  let nextId = 0
  globalThis.setTimeout = ((callback: () => void) => {
    callbacks.set(++nextId, callback)
    return nextId
  }) as any
  globalThis.clearTimeout = ((id: number) => callbacks.delete(id)) as any
  const environment = fixture({
    endsAt: Date.now() + 60_000,
    endOfTrack: false,
  })
  const store = createSleepTimerStore(environment.persist, player)
  await settle()
  expect(callbacks.size).toBe(1)
  environment.setRaw(
    JSON.stringify({ version: 0, state: { endsAt: null, endOfTrack: false } })
  )
  await store.persist.rehydrate()
  expect(callbacks.size).toBe(0)
})
