import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { hydratePlaylist, type RemotePlaylist } from "../src/mixedPlaylists/model"
import { COUNTERPART_POLICY, counterpartPending, matchPlaylistBatch, recordingFingerprint } from "../src/mixedPlaylists/matching"
import { nextPlaylistSyncAt, PLAYLIST_CHECK_INTERVAL, PLAYLIST_CONTINUATION_INTERVAL } from "../src/mixedPlaylists/schedule"
import type { MusicTrack } from "../src/types/music"

const track = { id: "1", title: "Song", artistName: "Artist", albumName: "Album", duration: 180000 } as MusicTrack
const source: RemotePlaylist = { service: "plex", owner: "scope", id: "10", title: "List", readOnly: false,
  items: [{ occurrenceId: "one", track }] }
const checkedAt = 1_000_000
function settled() {
  const playlist = hydratePlaylist(source)
  playlist.owners.ytmusic = "account"
  playlist.syncCheckedAt = checkedAt
  playlist.items[0].match = { status: "missing", policy: COUNTERPART_POLICY, checkedAt: 1,
    fingerprint: recordingFingerprint(track) }
  return playlist
}

test("settled misses remain idle until the persisted hourly check, including after restart", () => {
  const playlist = settled()
  expect(nextPlaylistSyncAt(playlist)).toBe(checkedAt + PLAYLIST_CHECK_INTERVAL)
  expect(nextPlaylistSyncAt(JSON.parse(JSON.stringify(playlist)))).toBe(checkedAt + PLAYLIST_CHECK_INTERVAL)
  expect(nextPlaylistSyncAt(playlist, checkedAt + 100)).toBe(checkedAt + 100 + PLAYLIST_CHECK_INTERVAL)
})
test("an unconfirmed write alone waits for the hourly check rather than looping every 30 seconds", () => {
  const playlist = settled()
  playlist.status = "error"
  playlist.write = { id: "pending", service: "plex", kind: "move", state: "unknown", before: source, afterIds: ["1"] }
  expect(nextPlaylistSyncAt(playlist)).toBe(checkedAt + PLAYLIST_CHECK_INTERVAL)
})
test("new matching work and a successful bounded write tail can continue promptly", () => {
  const playlist = settled()
  playlist.items[0].match.status = "pending"
  expect(nextPlaylistSyncAt(playlist)).toBe(checkedAt + PLAYLIST_CONTINUATION_INTERVAL)
  playlist.items[0].match.status = "missing"
  playlist.status = "syncing"
  expect(nextPlaylistSyncAt(playlist)).toBe(checkedAt + PLAYLIST_CONTINUATION_INTERVAL)
})
test("terminal misses are reused regardless of age, while changed recording data is matched again", async () => {
  let playlist = settled(), calls = 0
  const match = () => matchPlaylistBatch(playlist, "ytmusic", { current: () => true, save: async value => value,
    resolve: async () => { calls++; return { status: "missing", checkedAt: Date.now(), message: "No match" } } })
  expect(counterpartPending(playlist.items[0], "ytmusic")).toBe(false)
  await match()
  expect(calls).toBe(0)
  playlist.items[0].songs.plex!.track = { ...track, title: "Changed Song" }
  expect(counterpartPending(playlist.items[0], "ytmusic")).toBe(true)
  playlist = (await match()).playlist
  expect(calls).toBe(1)
  expect(counterpartPending(playlist.items[0], "ytmusic")).toBe(false)
  await match()
  expect(calls).toBe(1)
})
test("manual upstream checks, changed songs and explicit matching retries stay separate in the store", async () => {
  const child = Bun.spawn([process.execPath, "tests/fixtures/mixedPlaylistSync.ts"], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  })
  const [status, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ status, output: out + err }).toEqual({ status: 0, output: "" })
})
