import { expect, test } from "bun:test"
import {
  createMatchingNoticeReceipts,
  matchingResultNotice,
} from "../src/playlistSync/matchingNotices"
import type { LinkedPlaylist } from "../src/playlistSync/linked"

const link = {
  id: "link",
  enabled: true,
  paused: false,
  state: "ready",
  library: { service: "library:Plex", user: "library", revision: "scope" },
  listenbrainz: {
    service: "listenbrainz",
    user: "listener",
    revision: "lease",
  },
  message:
    "1 of 2 songs matched. Review unmatched songs; every original occurrence is retained.",
  incomplete: {
    sourceSnapshot: {
      id: "source",
      items: [
        { occurrenceId: "one", track: { id: "recording-one" } },
        { occurrenceId: "two", track: { id: "recording-two" } },
      ],
    },
    matchedCount: 1,
    total: 2,
    missingOccurrenceIds: ["two"],
    matchingDone: true,
  },
} as LinkedPlaylist
test("matching notices wait for verified filling and distinguish review results from interruptions", () => {
  expect(matchingResultNotice(link)?.title).toBe("Playlist matches saved")
  expect(
    matchingResultNotice({
      ...link,
      message: "Matching the selected playlist in bounded background batches.",
    })
  ).toBeUndefined()
  expect(matchingResultNotice({ ...link, job: {} as any })).toBeUndefined()
  expect(
    matchingResultNotice({ ...link, paused: true, state: "conflict" })?.title
  ).toBe("Playlist matches saved")
  expect(
    matchingResultNotice({
      ...link,
      paused: true,
      state: "conflict",
      message: "Destination changed",
    })?.title
  ).toBe("Playlist sync needs attention")
  expect(
    matchingResultNotice({
      ...link,
      paused: true,
      state: "unknown",
      job: {} as any,
    })?.severity
  ).toBe("warning")
  expect(
    matchingResultNotice({ ...link, pauseReason: "manual", paused: true })
  ).toBeUndefined()
  expect(matchingResultNotice({ ...link, enabled: false })).toBeUndefined()
})
test("completed matching receipts survive restart without storing playlist metadata", async () => {
  let saved: string | null = null
  const storage = {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value
    },
  }
  const event = matchingResultNotice(link)!.eventKey!
  const firstSession = createMatchingNoticeReceipts(() => storage)
  expect(await firstSession(event, () => true)).toBe(true)
  expect(await firstSession(event, () => true)).toBe(false)
  const restarted = createMatchingNoticeReceipts(() => storage)
  expect(await restarted(event, () => true)).toBe(false)
  const hashes = JSON.parse(saved!)
  expect(hashes).toHaveLength(1)
  expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/)
  expect(saved).not.toContain("listener")
  expect(saved).not.toContain("recording-one")
  const changed = {
    ...link,
    message:
      "No reliable matches were found. Review the retained source songs before filling the playlist.",
    incomplete: {
      ...link.incomplete!,
      matchedCount: 0,
      missingOccurrenceIds: ["one", "two"],
    },
  }
  expect(
    await restarted(matchingResultNotice(changed)!.eventKey!, () => true)
  ).toBe(true)
  const otherAccount = {
    ...link,
    listenbrainz: { ...link.listenbrainz, user: "other" },
  }
  expect(
    await restarted(matchingResultNotice(otherAccount)!.eventKey!, () => true)
  ).toBe(true)
})
test("late receipt hashing cannot mark a retired result as shown, and storage errors are harmless", async () => {
  let writes = 0,
    current = true
  const receipts = createMatchingNoticeReceipts(() => ({
    getItem: () => null,
    setItem: () => {
      writes++
    },
  }))
  const pending = receipts("old", () => current)
  current = false
  expect(await pending).toBe(false)
  expect(writes).toBe(0)
  const unavailable = createMatchingNoticeReceipts(() => {
    throw Error("Storage unavailable")
  })
  expect(await unavailable("new", () => true)).toBe(true)
  expect(await unavailable("retired", () => false)).toBe(false)
})
