import { expect, mock, test } from "bun:test"
import {
  createPlexConnectionStore,
  type ConnectionDependencies,
} from "../src/backends/plex/connectionLifecycle"
import { createSavedLibraryProvider } from "../src/offline/offlineProvider"
import { offlineKey } from "../src/offline/providerCache"
import type { OfflineContext } from "../src/offline/nativeCache"
import type { PlexSettings } from "../src/backends/plex/types"
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const context = (revision: number): OfflineContext => ({
  revision,
  cacheScope: "plex-" + "a".repeat(64),
  baseUrl: "https://saved.test",
  machineIdentifier: "saved-server",
  sectionId: 1,
  sectionUuid: "saved-library",
  sectionTitle: "Saved music library",
})
function setup(overrides: Partial<ConnectionDependencies> = {}) {
  let revision = 0
  const deps: ConnectionDependencies = {
    loadSettings: async () => ({}) as PlexSettings,
    connectPlex: async () => {
      throw new Error("should not connect")
    },
    disconnectPlex: mock(async () => ++revision),
    saveSettings: mock(async () => {}),
    testServerConnection: mock(async () => {
      throw new Error("should not probe")
    }),
    startPlexAuth: async () => {
      throw new Error("unused")
    },
    createProvider: async () => {
      throw new Error("should not create network provider")
    },
    activateProvider: async () => {},
    clearSession: mock(() => {}),
    restoreOfflineContext: mock(async (r) => context(r)),
    activateOfflineProvider: mock(async () => {}),
    ...overrides,
  }
  return { deps, store: createPlexConnectionStore(deps) }
}
test("explicit offline entry uses trusted native context and never connects/probes/saves credentials", async () => {
  const { store, deps } = setup()
  await store.getState().browseSavedLibrary()
  expect(store.getState().isOffline).toBe(true)
  expect(store.getState().isConnected).toBe(false)
  expect(store.getState().token).toBe("")
  expect(store.getState().musicSectionId).toBe(1)
  expect(deps.saveSettings).not.toHaveBeenCalled()
  expect(deps.testServerConnection).not.toHaveBeenCalled()
  expect(deps.activateOfflineProvider).toHaveBeenCalledTimes(1)
})
test("logout retires late offline restore and clears visible offline identity", async () => {
  const pending = deferred<OfflineContext>()
  const { store, deps } = setup({
    restoreOfflineContext: () => pending.promise,
  })
  const entry = store.getState().browseSavedLibrary()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await store.getState().disconnectAndClear()
  pending.resolve(context(1))
  await entry
  expect(store.getState().isOffline).toBe(false)
  expect(store.getState().musicSectionId).toBeNull()
  expect(deps.activateOfflineProvider).not.toHaveBeenCalled()
})
test("invalid or unavailable native identity cannot activate frontend last-account state", async () => {
  const { store, deps } = setup({
    restoreOfflineContext: async (r) => ({
      ...context(r),
      cacheScope: "untrusted-last-scope",
    }),
  })
  await store.getState().browseSavedLibrary()
  expect(store.getState().isOffline).toBe(false)
  expect(store.getState().error).toContain("saved library is unavailable")
  expect(deps.activateOfflineProvider).not.toHaveBeenCalled()
})
test("saved-only provider returns exact cached model pages, blocks writes/playback and is not thenable", async () => {
  let current = true
  const requests: string[] = []
  const provider = createSavedLibraryProvider(
    context(1).cacheScope,
    {
      get: async (key) => {
        requests.push(key)
        return key === offlineKey("getPlaylistItems", ["1", 0, 2])
          ? {
              payload: {
                items: [
                  { id: "1", playlistItemId: "a" },
                  { id: "1", playlistItemId: "b" },
                ],
                total: 4,
              },
              cachedAt: 1,
            }
          : null
      },
      put: async () => {
        throw new Error("no writes")
      },
    },
    () => current
  )
  expect(await Promise.resolve(provider)).toBe(provider)
  expect(provider.isConnected()).toBe(false)
  expect(provider.capabilities.playlistEdit).toBe(false)
  expect((await provider.getPlaylistItems("1", 0, 2)).items).toHaveLength(2)
  await expect(provider.getPlaylistItems("1", 2, 2)).rejects.toThrow(
    "has not been saved"
  )
  await expect(provider.rate("1", 10)).rejects.toThrow("Reconnect")
  await expect(provider.getPlaybackInfo({} as any)).rejects.toThrow("Reconnect")
  current = false
  await expect(provider.getAlbum("1")).rejects.toThrow("superseded")
  expect(requests).toHaveLength(2)
})

test("saved library preserves Hibiki-owned favorite reads and writes without enabling Plex edits", async () => {
  const writes: unknown[] = []
  const favorites = {
    load: async () => ({ revision: 1 }),
    save: async (...args: unknown[]) => {
      writes.push(args)
      return 2
    },
  } as any
  const provider = createSavedLibraryProvider(
    context(1).cacheScope,
    { get: async () => null, put: async () => {} },
    () => true,
    undefined,
    favorites
  )
  expect((await provider.favorites!.load()).revision).toBe(1)
  expect(await provider.favorites!.save(1, {} as any, [])).toBe(2)
  expect(writes).toHaveLength(1)
  expect(provider.capabilities.playlistEdit).toBe(false)
  await expect(provider.editPlaylist("1", {} as any)).rejects.toThrow(
    "Reconnect"
  )
})
