import { expect, test } from "bun:test"
import {
  createEntityDownloads,
  downloadLabel,
  isDownloadEntity,
  type EntityDownloadStatus,
} from "../src/offline/downloadEntities"
import type { MusicProvider } from "../src/providers/types"
import { deferred } from "./helpers/radioAudioFakes"

const scope = `plex-${"a".repeat(64)}`
test("entity downloads retain native scope and fence owner retirement before and after RPC", async () => {
  const provider = { cacheScope: scope, playbackSession: {} } as MusicProvider
  const context = { connectionRevision: 7, cacheScope: scope }
  const wait = deferred<any>(),
    calls: any[] = []
  let current = true
  const api = createEntityDownloads(
    { provider, context, session: provider.playbackSession },
    () => current,
    async (command, args) => {
      calls.push({ command, args })
      return wait.promise
    }
  )
  context.connectionRevision = 9
  const pending = api.download("artist", "42")
  expect(calls[0]).toEqual({
    command: "download_entity",
    args: {
      kind: "artist",
      id: 42,
      context: { connectionRevision: 7, cacheScope: scope },
    },
  })
  current = false
  wait.resolve(3)
  await expect(pending).rejects.toThrow("superseded")
  await expect(api.remove("artist", "42")).rejects.toThrow("superseded")
  expect(calls).toHaveLength(1)
})
test("offline permits local removal but rejects download preparation and synthetic identities", async () => {
  const provider = { cacheScope: scope, isOffline: true } as MusicProvider
  const calls: string[] = []
  const api = createEntityDownloads(
    {
      provider,
      context: { connectionRevision: 1, cacheScope: scope },
      session: provider.playbackSession,
    },
    () => true,
    async <T>(command: string) => {
      calls.push(command)
      return undefined as T
    }
  )
  await expect(api.download("playlist", "42")).rejects.toThrow("Reconnect")
  await api.remove("playlist", "42")
  expect(calls).toEqual(["remove_entity_download"])
  expect(() => api.status([{ kind: "artist", id: "mix://generated" }])).toThrow(
    "Invalid"
  )
  for (const id of ["0", "-1", "1.5", "9007199254740992", "42&scope=other"])
    expect(isDownloadEntity("album", id)).toBe(false)
})
test("download status distinguishes full verified membership, partial, failed and automatic cache absence", () => {
  const status: EntityDownloadStatus = {
    kind: "album",
    id: 42,
    known: true,
    total: 10,
    downloaded: 10,
    pending: 0,
    failed: 0,
    requested: true,
  }
  expect(downloadLabel(status)).toContain("10 tracks available offline")
  expect(downloadLabel({ ...status, known: false })).toBe(
    "10 of 10 tracks downloaded"
  )
  expect(downloadLabel({ ...status, downloaded: 3, pending: 7 })).toBe(
    "Downloading · 3 of 10 tracks available offline"
  )
  expect(downloadLabel({ ...status, downloaded: 3, pending: 7 }, true)).toBe("Download paused · 3 of 10 tracks available offline")
  expect(downloadLabel({ ...status, downloaded: 3, failed: 2 })).toBe(
    "3 of 10 tracks downloaded · 2 need attention"
  )
  expect(downloadLabel({...status, kind:"track",total:1,downloaded:0,failed:1,error:"This audio file could not be decoded."})).toContain("This audio file could not be decoded.")
  expect(
    downloadLabel({ ...status, downloaded: 0, requested: false })
  ).toBeNull()
  expect(downloadLabel({ ...status, total: 0, downloaded: 0 })).not.toContain(
    "available offline"
  )
})
