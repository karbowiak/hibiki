import assert from "node:assert/strict"
import { mock } from "bun:test"
import { deferred } from "../helpers/radioAudioFakes"

let gate: ReturnType<typeof deferred<void>> | undefined
mock.module("../../src/playlistSync/initialMatching", () => ({
  matchInitialSync: async () => {
    if (gate) await gate.promise
  },
}))
const { useProviderStore } = await import("../../src/stores/providerStore")
const { useListenBrainzStore } =
  await import("../../src/metadata/listenbrainz/authStore")
const { useLinkedPlaylistStore } =
  await import("../../src/stores/linkedPlaylistStore")
const { providerPlaylistAccount } =
  await import("../../src/playlistSync/provider")
const provider: any = { name: "Plex", cacheScope: "scope", playbackSession: {} }
useProviderStore.setState({ provider })
useListenBrainzStore.setState({ isAuthenticated: true, username: "owner" })
useLinkedPlaylistStore.setState({
  error: null,
  links: [
    {
      id: "link",
      library: providerPlaylistAccount(provider),
      listenbrainz: { user: "owner" },
    } as any,
  ],
  checkedErrors: { link: "Previous lookup failed" },
})
await useLinkedPlaylistStore.getState().matchIncomplete("link")
assert.equal(
  useLinkedPlaylistStore.getState().checkedErrors.link,
  undefined,
  "Successful background matching clears the stale error"
)
gate = deferred<void>()
useLinkedPlaylistStore.getState().checkError("link", "New owner error")
const pending = useLinkedPlaylistStore.getState().matchIncomplete("link")
useProviderStore.setState({ provider: { ...provider, cacheScope: "other" } })
useProviderStore.setState({ provider })
gate.resolve()
await pending
assert.equal(
  useLinkedPlaylistStore.getState().checkedErrors.link,
  "New owner error",
  "A retired matcher cannot clear a replacement owner's error"
)
assert.equal(useLinkedPlaylistStore.getState().running.link, undefined)
