import { test, expect } from "bun:test"
import { runLivePlaylistSmoke } from "./fixtures/livePlaylistSync/runner"
import { applySequenceOperation } from "../src/playlistSync/linked"
const run = "99999999-9999-4999-8999-999999999999",
  title = `Hibiki QA ${run}`
const ids = ["1", "2", "3"],
  mbids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ]
for (const distinct of [false, true])
  test(`live smoke runner production adapters/order/conflict/recovery (${distinct ? "distinct" : "duplicate"})`, async () => {
    let library = distinct ? [ids[0], ids[1]] : [ids[0], ids[1], ids[0]],
      remote = distinct ? [mbids[0], mbids[1]] : [mbids[0], mbids[1], mbids[0]],
      journals = 0,
      writes = 0
    const localAccount = {
        service: "library:Plex",
        user: "qa-owner",
        revision: "scope-v1",
      },
      remoteAccount = {
        service: "listenbrainz",
        user: "qa-user",
        revision: "qa-revision",
      }
    const mappings = ids.map((id, index) => ({
      libraryTrack: {
        id,
        title: `Song ${index}`,
        artist: "Synthetic Artist",
        album: "Synthetic Album",
        durationMs: 200000,
      },
      recordingMbid: mbids[index],
      verifiedBy: "provider-mbid",
    }))
    const snapshot = () => ({
      account: localAccount,
      id: "owned-library",
      title,
      items: library.map((id, index) => ({
        occurrenceId: String(index + 1),
        track: mappings.find((m) => m.libraryTrack.id === id)!.libraryTrack,
      })),
    })
    const jspf = () => ({
      playlist: {
        title,
        identifier:
          "https://listenbrainz.org/playlist/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        track: remote.map((id) => ({
          identifier: [`https://musicbrainz.org/recording/${id}`],
        })),
      },
    })
    const stages: string[] = []
    const result = await runLivePlaylistSmoke({
      request: async <T>(action: string, payload: any): Promise<T> => {
        let value: any
        if (action === "session")
          value = {
            runId: run,
            title,
            libraryId: "owned-library",
            remoteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            libraryAccount: localAccount,
            remoteAccount,
            tracks: mappings,
            initialLayout: distinct ? "distinct" : "duplicate",
          }
        else if (action === "library.read") value = snapshot()
        else if (action === "remote.read") value = jspf()
        else if (action === "remote.account") value = remoteAccount
        else if (action === "journal.retain") {
          journals++
          value = null
        } else if (action === "library.mutate") {
          expect(journals).toBeGreaterThan(0)
          expect(payload.before.id).toBe("owned-library")
          library = applySequenceOperation(library, payload.operation)
          writes++
          value = snapshot()
        } else if (action === "remote.mutate") {
          expect(journals).toBeGreaterThan(0)
          expect(payload.before.id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          remote = applySequenceOperation(remote, payload.operation)
          writes++
          value = jspf()
        } else if (action === "proof.stage") {
          stages.push(payload.name)
          value = null
        } else throw Error("Unexpected QA action")
        return structuredClone(value) as T
      },
    })
    expect(result).toEqual({
      stages: 5,
      libraryOccurrenceWrites: 3,
      remoteOccurrenceWrites: 4,
      retainedPaused: true,
    })
    expect(writes).toBe(7)
    expect(stages).toEqual([
      distinct ? "initial-distinct-order" : "initial-duplicate-order",
      "library-to-listenbrainz",
      "listenbrainz-to-library",
      "both-sided-conflict",
      "simulated-ack-loss-read-only-recovery",
    ])
    expect(library).toEqual(
      distinct ? ["1", "3", "2"] : ["1", "3", "2", "1", "2"]
    )
    expect(remote).toEqual(
      distinct
        ? [mbids[0], mbids[2], mbids[1]]
        : [mbids[0], mbids[2], mbids[1], mbids[0], mbids[2], mbids[1]]
    )
  })
test("unreviewed session rejects before any QA mutation", async () => {
  let requests = 0
  await expect(
    runLivePlaylistSmoke({
      request: async <T>(): Promise<T> => {
        requests++
        return { runId: run, title: "Existing real playlist", tracks: [] } as T
      },
    })
  ).rejects.toThrow("Unreviewed")
  expect(requests).toBe(1)
})
