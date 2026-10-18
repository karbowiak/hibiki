import { expect, test } from "bun:test"
import {
  downloadActivity,
  matchingIndexActivity,
  mixedPlaylistActivity,
  ownsPlaylistActivity,
} from "../src/activity/model"
import { monitorActivity } from "../src/activity/native"
import { beginActivity, useActivityStore } from "../src/activity/store"
import {
  hydratePlaylist,
  type MixedPlaylist,
} from "../src/mixedPlaylists/model"
import { COUNTERPART_POLICY } from "../src/mixedPlaylists/matching"
import { youtubeMusicTrack } from "../src/backends/ytmusic/tracks"

function playlist(): MixedPlaylist {
  const track = youtubeMusicTrack({
    videoId: "a1234567890",
    title: "Song",
    artist: "Artist",
    album: "Album",
    duration: "3:00",
    thumbnail: null,
  })
  const initial = hydratePlaylist({
    service: "plex",
    id: "1",
    title: "Mixed playlist",
    owner: "plex-owner",
    readOnly: false,
    items: [1, 2, 3, 4].map((id) => ({
      track: { ...track, id: String(id) },
      occurrenceId: String(id),
    })),
  })
  initial.owners.ytmusic = "ytm-owner"
  initial.automatic = true
  initial.items[0].songs.ytmusic = { track }
  initial.items[1].match = {
    status: "missing",
    policy: COUNTERPART_POLICY,
    checkedAt: 100,
  }
  initial.items[2].match = {
    status: "failed",
    policy: COUNTERPART_POLICY,
    checkedAt: 100,
  }
  return initial
}

test("playlist progress distinguishes checks, available recordings and acknowledged syncs", () => {
  const value = playlist()
  const activity = mixedPlaylistActivity(value, true, {
    kind: "matching",
    target: "ytmusic",
  })!
  expect(activity.busy).toBe(true)
  expect(activity.detail).toContain("Matching YTM")
  expect(activity.detail).toContain("3 of 4 songs checked")
  expect(activity.detail).toContain("Plex · 4 available · 4 synced")
  expect(activity.detail).toContain("YTM · 1 available · 0 synced")
  expect(activity.progress).toEqual({
    value: 3,
    total: 4,
    label: "Songs checked",
  })
  const waiting = mixedPlaylistActivity(value, false)!
  expect(waiting.state).toBe("waiting")
  expect(waiting.busy).toBe(false)
})

test("ordinary matcher misses finish quietly; uncertain writes link to Info while matching can continue", () => {
  const value = playlist()
  value.items[3].match = {
    status: "missing",
    policy: COUNTERPART_POLICY,
    checkedAt: 100,
  }
  expect(mixedPlaylistActivity(value, false)).toBeNull()
  value.write = {
    id: "write",
    service: "ytmusic",
    kind: "append",
    afterIds: [],
    state: "unknown",
  }
  const review = mixedPlaylistActivity(value, false)!
  expect(review.state).toBe("paused")
  expect(review.detail).not.toContain("failed")
  expect(review.action?.href).toContain("?info=sync")
  const ongoing = mixedPlaylistActivity(value, true, {
    kind: "matching",
    target: "ytmusic",
  })!
  expect(ongoing.busy).toBe(true)
  expect(ongoing.detail).toContain("matching continues")
})

test("old accounts cannot surface playlist activity, including locally saved drafts", () => {
  const value = { ...playlist(), local: true as const }
  expect(
    ownsPlaylistActivity(value, { plex: "plex-owner", ytmusic: "ytm-owner" })
  ).toBe(true)
  expect(ownsPlaylistActivity(value, { plex: "plex-owner" })).toBe(false)
  expect(
    ownsPlaylistActivity(value, { plex: "another", ytmusic: "ytm-owner" })
  ).toBe(false)
  expect(mixedPlaylistActivity(value, false, undefined, true)?.state).toBe(
    "paused"
  )
})

test("download queue activity includes remaining work, transfer progress and offline pause", () => {
  const summary = {
    queued: 9,
    downloading: 1,
    paused: 0,
    failed: 2,
    downloaded: 100,
    received: 25,
    total: 100,
  }
  const running = downloadActivity(summary, false)!
  expect(running.busy).toBe(true)
  expect(running.detail).toContain("100 saved · 10 remaining")
  expect(running.detail).toContain("Current song · 25%")
  expect(running.detail).toContain("2 failed")
  expect(downloadActivity(summary, true)?.state).toBe("paused")
  expect(downloadActivity(summary, true)?.busy).toBe(false)
  expect(
    downloadActivity({ ...summary, queued: 0, downloading: 0 }, false)?.state
  ).toBe("error")
  expect(
    downloadActivity(
      { ...summary, queued: 0, downloading: 0, failed: 0 },
      false
    )
  ).toBeNull()
})

test("matching index reports actual compact-index work and respects pause/backoff", () => {
  const status = {
    epoch: 1,
    revision: 1,
    paused: false,
    tasks: [
      {
        kind: "track" as const,
        phase: "scan" as const,
        offset: 20,
        total: 100,
        count: 20,
        started: 1,
        completed: null,
        requests: 1,
        bytes: 1000,
        error: null,
        retryAt: 0,
      },
    ],
  }
  expect(matchingIndexActivity(status)?.detail).toContain(
    "Songs · 20 of 100 · indexing"
  )
  expect(matchingIndexActivity(status)?.busy).toBe(true)
  expect(matchingIndexActivity({ ...status, paused: true })?.state).toBe(
    "paused"
  )
  expect(
    matchingIndexActivity(
      { ...status, tasks: [{ ...status.tasks[0], retryAt: 2000 }] },
      1000
    )?.state
  ).toBe("waiting")
  expect(
    matchingIndexActivity({
      ...status,
      tasks: [{ ...status.tasks[0], phase: "complete" }],
    })
  ).toBeNull()
})

test("activity leases cannot update or clear a newer operation with the same ID", () => {
  const first = beginActivity(
    { id: "test", label: "First", busy: true },
    () => true
  )
  const second = beginActivity(
    { id: "test", label: "Second", busy: true },
    () => true
  )
  first.update({ label: "Late response" })
  first.finish()
  expect(useActivityStore.getState().jobs.test.activity.label).toBe("Second")
  second.finish()
  expect(useActivityStore.getState().jobs.test).toBeUndefined()
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 10))
test("activity polling coalesces wakes and discards late results on account change or unmount", async () => {
  let reads = 0,
    current = true
  const pending: ((value: number) => void)[] = [],
    seen: number[] = []
  const monitor = monitorActivity({
    current: () => current,
    read: () => {
      reads++
      return new Promise<number>((resolve) => pending.push(resolve))
    },
    publish: (value) => seen.push(value),
    interval: () => 60000,
  })
  try {
    monitor.offer()
    await flush()
    monitor.offer()
    monitor.offer()
    await flush()
    expect(reads).toBe(1)
    pending.shift()!(1)
    await flush()
    expect(seen).toEqual([1])
    expect(reads).toBe(2)
    current = false
    pending.shift()!(2)
    await flush()
    expect(seen).toEqual([1])
    monitor.offer()
    await flush()
    expect(reads).toBe(2)
  } finally {
    monitor.stop()
  }
  const stopped = monitorActivity({
    current: () => true,
    read: () => new Promise<number>((resolve) => pending.push(resolve)),
    publish: (value) => seen.push(value),
    interval: () => 60000,
  })
  stopped.offer()
  await flush()
  stopped.stop()
  pending.shift()!(3)
  await flush()
  expect(seen).toEqual([1])
})
