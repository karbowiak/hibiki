import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { deferred, settle } from "../helpers/radioAudioFakes"
const dom = new JSDOM('<div id="root"></div>', {
  url: "https://synthetic.test",
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { createRoot } = await import("react-dom/client")
const { VerifiedRecordingsAction } =
  await import("../../src/components/PlaylistSync/VerifiedRecordingsAction")
const { useProviderStore } = await import("../../src/stores/providerStore")
const { planPlaylistCopy } = await import("../../src/playlistSync/planner")
const scenario = process.argv[2],
  mbid = "11111111-1111-4111-8111-111111111111"
const gate = deferred<any>(),
  calls: string[] = []
const provider: any = {
  name: "Plex",
  cacheScope: "scope",
  playbackSession: {},
  resolvePlaylistRecording: async (track: any) => {
    calls.push(track.id)
    return track.id === "1"
      ? gate.promise
      : { status: "unmatched", reason: "no-proof" }
  },
}
useProviderStore.setState({ provider })
const source = {
  account: { service: "library:Plex", user: "scope", revision: "scope-v1" },
  id: "local",
  title: "Local",
  items: ["1", "2", "1"].map((id, index) => ({
    occurrenceId: String(index),
    track: { id, title: "Song " + id, artist: "Artist", durationMs: 200000 },
  })),
}
const plan = planPlaylistCopy(
  source,
  { service: "listenbrainz", user: "listener", revision: "lease" },
  { direction: "export" }
)
let resolved: any = null,
  owned = true
const root = createRoot(document.getElementById("root")!)
await act(() =>
  root.render(
    <VerifiedRecordingsAction
      provider={provider}
      plan={plan}
      current={() => () => owned}
      disabled={false}
      onResolved={(value) => {
        resolved = value
      }}
    />
  )
)
assert.equal(calls.length, 0, "No automatic lookup before explicit action")
const button = (label: string) => {
  const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label
  )
  assert.ok(b)
  return b
}
await act(async () => {
  button("Resolve verified recording IDs").click()
  await settle()
})
assert.deepEqual(calls, ["1"])
if (scenario === "cancel") await act(() => button("Cancel lookup").click())
if (scenario === "retired")
  await act(() => {
    useProviderStore.setState({
      provider: { ...provider, cacheScope: "other" },
    })
    useProviderStore.setState({ provider })
  })
await act(async () => {
  gate.resolve({
    status: "verified",
    recordingMbid: mbid,
    proof: "explicit-recording-guid",
    metadataFingerprint: "a".repeat(64),
  })
  await settle()
})
if (scenario === "verified") {
  assert.deepEqual(calls, ["1", "2"], "Duplicate IDs resolved once")
  assert.equal(resolved.rows.length, 3, "No occurrence removed")
  assert.equal(resolved.rows[0].match.by, "mbid")
  assert.equal(resolved.rows[2].match.by, "mbid")
  assert.equal(resolved.rows[1].match.status, "missing")
  assert.equal(
    resolved.source.items[0].track.recordingMbid,
    undefined,
    "Frozen source preview remains unchanged"
  )
  assert.ok(document.body.textContent!.includes("2 of 3 occurrences"))
} else if (scenario === "cancel") {
  assert.deepEqual(calls, ["1"])
  assert.ok(resolved.rows.every((r: any) => r.match.status === "missing"))
  assert.ok(document.body.textContent!.includes("Cancelled."))
} else {
  assert.equal(resolved, null)
  assert.deepEqual(calls, ["1"])
}
await act(() => root.unmount())
dom.window.close()
