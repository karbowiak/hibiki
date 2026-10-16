import { expect, mock, test } from "bun:test"
import {
  createPlexConnectionStore,
  ConnectionSupersededError,
  type ConnectionDependencies
} from "../src/backends/plex/connectionLifecycle"
import type { LibrarySection, PlexSettings } from "../src/backends/plex/types"
import type { MusicProvider } from "../src/providers/types"
import { deferred, settle } from "./helpers/radioAudioFakes"

const section = (key = 1, uuid = `library-${key}`) =>
  ({ key, uuid, title: `Music ${key}`, section_type: "artist" }) as LibrarySection
const info = (id: string, sections = [section()]) => ({ machineIdentifier: id, sections })
const settings = (extra: Partial<PlexSettings> = {}) =>
  ({
    base_url: "",
    token: "",
    all_urls: [],
    section_id: 0,
    tls_exceptions: [],
    machine_identifier: "",
    ...extra
  }) as PlexSettings
function harness(overrides: Partial<ConnectionDependencies> = {}) {
  let revision = 0
  const deps = {
    loadSettings: mock(async () => settings()),
    disconnectPlex: mock(async (_clear: boolean) => ++revision),
    connectPlex: mock(async (url: string, _token: string, _revision: number) => info(url)),
    saveSettings: mock(async (_revision: number, _urls: string[], _section?: number) => {}),
    testServerConnection: mock(async (_url: string, _identity?: string) => 10),
    startPlexAuth: mock(async () => {
      throw new Error("unused")
    }),
    createProvider: mock(async () => ({ disconnect: mock(async () => {}) }) as unknown as MusicProvider),
    activateProvider: mock(() => {}),
    clearSession: mock(() => {}),
    ...overrides
  }
  const store = createPlexConnectionStore(deps)
  return { deps, store, state: () => store.getState() }
}

test("a late old connection cannot overwrite the new provider, settings or error", async () => {
  const old = deferred<ReturnType<typeof info>>()
  const { state, deps } = harness({
    connectPlex: mock(async (url) => (url.includes("old") ? old.promise : info("new-server")))
  })
  const first = state()
    .connect("https://old.test", "old-token")
    .catch((error) => error)
  await settle()
  await state().connect("https://new.test", "new-token")
  old.resolve(info("old-server"))
  expect(await first).toBeInstanceOf(ConnectionSupersededError)
  expect(state().baseUrl).toBe("https://new.test")
  expect(state().token).toBe("new-token")
  expect(state().isConnected).toBe(true)
  expect(state().error).toBeNull()
  expect(deps.activateProvider).toHaveBeenCalledTimes(1)
  expect(deps.saveSettings.mock.calls.every((call) => call[1][0] === "https://new.test")).toBe(true)
})

test("logout immediately clears playback and UI and revokes a pending native connection", async () => {
  const pending = deferred<ReturnType<typeof info>>()
  const { state, deps } = harness({ connectPlex: mock(() => pending.promise) })
  const attempt = state()
    .connect("https://server.test", "dummy-token")
    .catch((error) => error)
  await settle()
  const before = deps.clearSession.mock.calls.length
  const logout = state().disconnectAndClear()
  expect(state().token).toBe("")
  expect(state().isConnected).toBe(false)
  expect(deps.clearSession.mock.calls.length).toBe(before + 1)
  await logout
  pending.resolve(info("retired"))
  await attempt
  expect(deps.disconnectPlex.mock.calls.map((call) => call[0])).toEqual([false, true])
  expect(deps.saveSettings).toHaveBeenCalledTimes(0)
  expect(deps.activateProvider).toHaveBeenCalledTimes(0)
  expect(state().isLoading).toBe(false)
})

test("fallbacks are anonymous identity probes; only the selected secure candidate connects", async () => {
  const secure = deferred<number>(),
    plain = deferred<number>(),
    foreign = deferred<number>()
  const probes = new Map([
    ["https://secure.test", secure],
    ["http://local.test", plain],
    ["https://foreign.test", foreign]
  ])
  const saved = settings({
    base_url: "https://offline.test",
    token: "dummy-token",
    machine_identifier: "verified-server",
    all_urls: [...probes.keys()]
  })
  const { state, deps } = harness({
    loadSettings: mock(async () => saved),
    connectPlex: mock(async (url) => {
      if (url.includes("offline")) throw new Error("Offline")
      return info("verified-server")
    }),
    testServerConnection: mock((url) => probes.get(url)!.promise)
  })
  const loading = state().loadAndConnect()
  await settle()
  expect(deps.testServerConnection.mock.calls.map((call) => call[1])).toEqual([
    "verified-server",
    "verified-server",
    "verified-server"
  ])
  plain.resolve(1)
  foreign.reject(new Error("Wrong server identity"))
  await settle()
  expect(deps.connectPlex).toHaveBeenCalledTimes(1)
  secure.resolve(30)
  await loading
  expect(deps.connectPlex.mock.calls.map((call) => call[0])).toEqual([
    "https://offline.test",
    "https://secure.test"
  ])
  expect(state().baseUrl).toBe("https://secure.test")
  expect(deps.activateProvider).toHaveBeenCalledTimes(1)
})

test("legacy settings without a verified server identity never expose a token to fallback addresses", async () => {
  const { state, deps } = harness({
    loadSettings: mock(async () =>
      settings({ base_url: "https://old.test", token: "dummy-token", all_urls: ["https://other.test"] })
    ),
    connectPlex: mock(async () => {
      throw new Error("Offline")
    })
  })
  await state().loadAndConnect()
  expect(deps.connectPlex).toHaveBeenCalledTimes(1)
  expect(deps.testServerConnection).toHaveBeenCalledTimes(0)
  expect(state().isConnected).toBe(false)
  expect(state().isLoading).toBe(false)
})

test("late startup settings cannot reconnect after logout", async () => {
  const loaded = deferred<PlexSettings>()
  const { state, deps } = harness({ loadSettings: mock(() => loaded.promise) })
  const startup = state().loadAndConnect()
  await settle()
  await state().disconnectAndClear()
  loaded.resolve(
    settings({ base_url: "https://old.test", token: "dummy-token", tls_exceptions: ["https://old.test"] })
  )
  await startup
  expect(deps.connectPlex).toHaveBeenCalledTimes(0)
  expect(state().tlsExceptions).toEqual([])
  expect(state().baseUrl).toBe("")
})

test("rapid library choices dispose retired providers and publish only the newest selection", async () => {
  const retired = deferred<MusicProvider>(),
    stopped = mock(async () => {})
  const { state, deps } = harness({
    connectPlex: mock(async () => info("server", [section(1), section(2)])),
    createProvider: mock(async (_context, selected) =>
      selected.key === 1 ? retired.promise : ({ disconnect: async () => {} } as MusicProvider)
    )
  })
  await state().connect("https://server.test", "dummy-token")
  expect(state().needsLibraryPick).toBe(true)
  const first = state()
    .selectLibrary(section(1))
    .catch((error) => error)
  await settle()
  await state().selectLibrary(section(2))
  retired.resolve({ disconnect: stopped } as unknown as MusicProvider)
  expect(await first).toBeInstanceOf(ConnectionSupersededError)
  expect(stopped).toHaveBeenCalledTimes(1)
  expect(state().musicSectionId).toBe(2)
  expect(deps.activateProvider).toHaveBeenCalledTimes(1)
})

test("library settings saves are ordered and a superseded save cannot publish a provider", async () => {
  const pending = deferred<void>()
  let active = 0,
    maximum = 0
  const { state, deps } = harness({
    connectPlex: mock(async () => info("server", [section(1), section(2)])),
    saveSettings: mock(async (_revision, _urls, id) => {
      active++
      maximum = Math.max(maximum, active)
      if (id === 1) await pending.promise
      active--
    })
  })
  await state().connect("https://server.test", "dummy-token")
  const first = state()
    .selectLibrary(section(1))
    .catch((error) => error)
  await settle()
  const second = state().selectLibrary(section(2))
  await settle()
  expect(deps.saveSettings.mock.calls.map((call) => call[2])).toEqual([undefined, 1])
  pending.resolve()
  await first
  await second
  expect(maximum).toBe(1)
  expect(deps.saveSettings.mock.calls.map((call) => call[2])).toEqual([undefined, 1, 2])
  expect(deps.createProvider).toHaveBeenCalledTimes(1)
  expect(state().musicSectionId).toBe(2)
})

test("a library from a different server is rejected before changing the active session", async () => {
  const { state, deps } = harness()
  await state().connect("https://server.test", "dummy-token")
  const before = deps.clearSession.mock.calls.length
  await expect(state().switchLibrary(section(1, "other-server-library"))).rejects.toThrow(
    "Select a music library"
  )
  expect(deps.clearSession.mock.calls.length).toBe(before)
  expect(state().isConnected).toBe(true)
})

test("failure after native authentication revokes its client and does not leave an active provider", async () => {
  const { state, deps } = harness({
    saveSettings: mock(async () => {
      throw new Error("Cannot persist settings")
    })
  })
  await expect(state().connect("https://server.test", "dummy-token")).rejects.toThrow(
    "Cannot persist settings"
  )
  expect(deps.disconnectPlex).toHaveBeenCalledTimes(2)
  expect(deps.activateProvider).toHaveBeenCalledTimes(0)
  expect(state().error).toContain("Cannot persist settings")
  expect(state().token).toBe("")
  expect(state().isLoading).toBe(false)
})

test("logout disk failures remain visible and do not restore the old session", async () => {
  const { state, deps } = harness({
    disconnectPlex: mock(async (clear) => {
      if (clear) throw new Error("Cannot clear saved credentials")
      return 1
    })
  })
  await state().connect("https://server.test", "dummy-token")
  await expect(state().disconnectAndClear()).rejects.toThrow("Cannot clear saved credentials")
  expect(state().token).toBe("")
  expect(state().error).toContain("Cannot clear saved credentials")
  expect(state().isConnected).toBe(false)
})

test("cancellation while provider caches hydrate cannot publish a retired connection", async () => {
  const hydrating = deferred<void>(),
    entered = deferred<void>()
  const { state } = harness({
    activateProvider: async (_provider, context) => {
      if (context.baseUrl.includes("old")) {
        entered.resolve()
        await hydrating.promise
      }
    }
  })
  const old = state()
    .connect("https://old.test", "dummy-old")
    .catch((error) => error)
  await entered.promise
  await state().connect("https://new.test", "dummy-new")
  hydrating.resolve()
  expect(await old).toBeInstanceOf(ConnectionSupersededError)
  expect(state().baseUrl).toBe("https://new.test")
  expect(state().isConnected).toBe(true)
})

test("cache hydration publishes only the provider whose activation still owns the connection", async () => {
  const firstHydration = deferred<void>(),
    entered = deferred<void>(),
    published: string[] = [],
    disconnected = mock(async () => {})
  const { state } = harness({
    createProvider: async () => ({ disconnect: disconnected }) as unknown as MusicProvider,
    activateProvider: async (_provider, context, _section, owns) => {
      if (context.baseUrl.includes("old")) {
        entered.resolve()
        await firstHydration.promise
      }
      if (owns()) published.push(context.baseUrl)
    }
  })
  const old = state()
    .connect("https://old.test", "dummy-old")
    .catch((error) => error)
  await entered.promise
  await state().connect("https://new.test", "dummy-new")
  firstHydration.resolve()
  await old
  expect(published).toEqual(["https://new.test"])
  expect(disconnected).toHaveBeenCalledTimes(1)
})

test("an explicitly selected remote library UUID must still match before activation", async () => {
  const h = harness()
  await expect(h.store.getState().connect("https://server.test","token",[],1,undefined,"server","deleted-library-uuid")).rejects.toThrow("music library changed")
  expect(h.store.getState().isConnected).toBe(false)
})
