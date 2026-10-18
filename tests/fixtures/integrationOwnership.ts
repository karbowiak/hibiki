import { mock } from "bun:test"
import assert from "node:assert/strict"

function deferred<T = any>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const pending: {
  command: string
  args: any
  response: ReturnType<typeof deferred>
}[] = []
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: (command: string, args: any) => {
    const response = deferred()
    pending.push({ command, args, response })
    return response.promise
  },
}))
const applicationStorage = await import("../../src/storage/clientStorage")
mock.module("../../src/storage/clientStorage", () => ({ ...applicationStorage,
  get: async () => undefined,
  update: async () => {},
  del: async () => {},
}))
function take(command: string) {
  const index = pending.findIndex((item) => item.command === command)
  assert.notEqual(index, -1, `Missing command ${command}`)
  return pending.splice(index, 1)[0]
}
const tick = () => new Promise<void>((done) => setImmediate(done))
const { useLastfmStore: lastfm } =
  await import("../../src/metadata/lastfm/authStore")
const { useListenBrainzStore: brainz } =
  await import("../../src/metadata/listenbrainz/authStore")
const scenario = process.argv[2]
const saved = {
  has_lastfm_session: true,
  lastfm_enabled: true,
  lastfm_api_key: "synthetic",
  lastfm_username: "old",
  lastfm_replace_metadata: true,
  lastfm_love_threshold: 8,
  has_listenbrainz_token: true,
  listenbrainz_enabled: true,
  listenbrainz_username: "old",
}

if (scenario === "hydration") {
  for (const store of [lastfm, brainz]) {
    const read = store.getState().initialize()
    const response = take("load_settings")
    const disconnect = store.getState().disconnect()
    take(
      store === lastfm ? "lastfm_disconnect" : "listenbrainz_disconnect"
    ).response.resolve(undefined)
    await disconnect
    response.response.resolve(saved)
    await read
    assert.equal(store.getState().isAuthenticated, false)
    assert.equal(store.getState().isEnabled, false)
    assert.equal(store.getState().username, null)
  }
  // A read begun while a mutation is pending cannot overwrite its completed value.
  const change = lastfm.getState().setEnabled(false)
  const mutation = take("lastfm_set_enabled")
  const read = lastfm.getState().initialize()
  const response = take("load_settings")
  mutation.response.resolve(undefined)
  await change
  response.response.resolve(saved)
  await read
  assert.equal(lastfm.getState().isEnabled, false)
  assert.equal(lastfm.getState().replaceMetadata, true)
} else if (scenario === "mutations") {
  for (const store of [lastfm, brainz]) {
    const command =
      store === lastfm ? "lastfm_set_enabled" : "listenbrainz_set_enabled"
    const first = store.getState().setEnabled(true)
    const old = take(command)
    const second = store.getState().setEnabled(false)
    take(command).response.resolve(undefined)
    await second
    old.response.resolve(undefined)
    await first
    assert.equal(store.getState().isEnabled, false)
  }
  const change = lastfm.getState().setLoveThreshold(10)
  const threshold = take("lastfm_set_love_threshold")
  const other = lastfm.getState().setReplaceMetadata(true)
  take("lastfm_set_replace_metadata").response.resolve(undefined)
  await other
  threshold.response.resolve(undefined)
  await change
  assert.equal(lastfm.getState().loveThreshold, 10)
  assert.equal(lastfm.getState().replaceMetadata, true)
} else if (scenario === "auth") {
  const auth = lastfm.getState().completeAuth("synthetic")
  const old = take("lastfm_complete_auth")
  const disconnect = lastfm.getState().disconnect()
  take("lastfm_disconnect").response.resolve(undefined)
  await disconnect
  old.response.resolve({ username: "obsolete" })
  await auth
  assert.equal(lastfm.getState().isAuthenticated, false)
  assert.equal(
    pending.some((item) => item.command === "lastfm_set_enabled"),
    false
  )

  const lastfmRead = lastfm.getState().initialize()
  const lastfmSettings = take("load_settings")
  const newAuth = lastfm.getState().completeAuth("synthetic")
  const session = take("lastfm_complete_auth")
  const disable = lastfm.getState().setEnabled(false)
  take("lastfm_set_enabled").response.resolve(undefined)
  await disable
  session.response.resolve({ username: "latest" })
  await newAuth
  lastfmSettings.response.resolve(saved)
  await lastfmRead
  assert.equal(lastfm.getState().username, "latest")
  assert.equal(lastfm.getState().isAuthenticated, true)
  assert.equal(lastfm.getState().isEnabled, false)
  assert.equal(
    pending.some((item) => item.command === "lastfm_set_enabled"),
    false
  )

  const read = brainz.getState().initialize()
  const response = take("load_settings")
  const login = brainz.getState().saveToken("synthetic")
  take("listenbrainz_save_token").response.resolve({ username: "new" })
  await login
  response.response.resolve(saved)
  await read
  assert.equal(brainz.getState().username, "new")
  assert.equal(brainz.getState().isAuthenticated, true)
  const nextLogin = brainz.getState().saveToken("synthetic")
  const validation = take("listenbrainz_save_token")
  const toggle = brainz.getState().setEnabled(false)
  assert.equal(
    pending.some((item) => item.command === "listenbrainz_set_enabled"),
    false
  )
  validation.response.resolve({ username: "newer" })
  await nextLogin
  await tick()
  const enabled = take("listenbrainz_set_enabled")
  assert.equal(enabled.args.enabled, false)
  enabled.response.resolve(undefined)
  await toggle
  assert.equal(brainz.getState().isEnabled, false)
  const obsoleteLogin = brainz.getState().saveToken("synthetic")
  const obsoleteValidation = take("listenbrainz_save_token")
  const logout = brainz.getState().disconnect()
  take("listenbrainz_disconnect").response.resolve(undefined)
  await logout
  obsoleteValidation.response.resolve({ username: "obsolete" })
  await obsoleteLogin
  assert.equal(brainz.getState().isAuthenticated, false)
  assert.equal(brainz.getState().username, null)
} else if (scenario === "now-playing") {
  const { PlexProvider } = await import("../../src/backends/plex/provider")
  const { useMbidStore } =
    await import("../../src/metadata/musicbrainz/mbidStore")
  const lookups = new Map<string, ReturnType<typeof deferred>>()
  useMbidStore.setState({
    lookup: async (_artist, title) => {
      const result = deferred()
      lookups.set(title, result)
      return result.promise
    },
  })
  const provider = new PlexProvider()
  const track = (title: string) =>
    ({ id: title, title, artistName: "Artist", duration: 180000 }) as any
  let audibleId = 1
  provider.onTrackStart(track("A"), () => audibleId === 1)
  audibleId = 2
  provider.onTrackStart(track("B"), () => audibleId === 2)
  lookups.get("B")!.resolve(null)
  await tick()
  assert.equal(take("listenbrainz_submit_now_playing").args.track, "B")
  lookups.get("A")!.resolve(null)
  await tick()
  assert.equal(
    pending.some((item) => item.command === "listenbrainz_submit_now_playing"),
    false
  )
  provider.onTrackStart(track("C"), () => audibleId === 3)
  lookups.get("C")!.resolve(null)
  await tick()
  assert.equal(
    pending.some((item) => item.command === "listenbrainz_submit_now_playing"),
    false
  )

  // Final listens belong to the native durable outbox, never this renderer hook.
  assert.equal((provider as any).onTrackEnd, undefined)
  assert.equal(pending.some(item => item.command === "lastfm_scrobble" || item.command === "listenbrainz_submit_listen"), false)

} else throw new Error(`Unknown scenario ${scenario}`)
