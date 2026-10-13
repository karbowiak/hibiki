import { test, expect } from "bun:test"
import {
  createPlexApi,
  type PlexTransport,
} from "../src/backends/plex/scopedApi"
const context = { connectionRevision: 7, cacheScope: `plex-${"a".repeat(64)}` }
test("scoped candidate RPC carries immutable ownership and explicit discovery metadata only", async () => {
  const calls: any[] = []
  const transport: PlexTransport = async (command, args) => {
    calls.push({ command, args })
    return { tracks: [], truncated: true, unavailable: false } as any
  }
  const api = createPlexApi(context, transport)
  expect(
    await api.findPlaylistCandidates(5, {
      title: "Song & 漢字",
      artist: "A feat. B",
      recordingMbid: "11111111-1111-4111-8111-111111111111",
    })
  ).toEqual({ tracks: [], truncated: true, unavailable: false })
  expect(calls).toEqual([
    {
      command: "playlist_sync_candidates",
      args: {
        context,
        sectionId: 5,
        source: {
          title: "Song & 漢字",
          artist: "A feat. B",
          recordingMbid: "11111111-1111-4111-8111-111111111111",
        },
      },
    },
  ])
})
