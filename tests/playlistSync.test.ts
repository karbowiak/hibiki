import { describe, expect, test } from "bun:test"
import { matchTrack } from "../src/playlistSync/matching"
import {
  planPlaylistCopy,
  resolvePlaylistOccurrence,
  resolvedTracks,
  snapshotRevision,
} from "../src/playlistSync/planner"
import { fromJspf, toJspf } from "../src/playlistSync/jspf"
import {
  executePlaylistCopy,
  PlaylistCopyApproval,
  PlaylistCopyError,
  reconcilePlaylistAttempt,
  dismissUnknownPlaylistAttempt,
} from "../src/playlistSync/execution"
import { playlistLinkChanges } from "../src/playlistSync/conflicts"
import { mergePlaylistAttempt } from "../src/playlistSync/journal"
import { listenBrainzPlaylistAdapter } from "../src/playlistSync/listenbrainz"
import { providerPlaylistAdapter } from "../src/playlistSync/provider"
import { lastFmPlaylistCapabilities } from "../src/playlistSync/lastfm"
import type {
  PlaylistAccount,
  PlaylistAdapter,
  PlaylistAttempt,
  PlaylistSnapshot,
  PlaylistTrack,
} from "../src/playlistSync/types"
const A = "12345678-1234-1234-1234-123456789abc",
  B = "22345678-1234-1234-1234-123456789abc",
  ID = "32345678-1234-1234-1234-123456789abc"
const local: PlaylistAccount = {
    service: "library:test",
    user: "opaque-library",
    revision: "1",
  },
  remote: PlaylistAccount = {
    service: "listenbrainz",
    user: "listener",
    revision: "1",
  }
const track = (id: string, mbid: string | null = A): PlaylistTrack => ({
  id,
  recordingMbid: mbid,
  title: "Track",
  artist: "Artist",
  album: "Album",
  durationMs: 100000,
})
const snapshot = (account = local): PlaylistSnapshot => ({
  account,
  id: "source",
  title: "Copy",
  items: [track("a"), track("b", B), track("a")].map((track, index) => ({
    occurrenceId: String(index),
    track,
  })),
})
function fixture() {
  let src = snapshot(),
    account = remote,
    current = true,
    writes = 0
  const attempts: PlaylistAttempt[] = []
  const source: PlaylistAdapter = {
    capabilities: { read: true, createCopy: true, replace: false },
    account: async () => src.account,
    read: async () => src,
    createCopy: async () => {
      throw Error("unexpected")
    },
  }
  const target: PlaylistAdapter = {
    capabilities: source.capabilities,
    account: async () => account,
    read: async (id) => ({
      ...src,
      account,
      id,
      items: src.items.map((item) => ({
        ...item,
        track: { ...item.track, id: item.track.recordingMbid! },
      })),
    }),
    createCopy: async () => {
      writes++
      return { id: ID }
    },
  }
  const journal = {
    list: async () => attempts,
    save: async (attempt: PlaylistAttempt) => {
      attempts.push(structuredClone(attempt))
    },
  }
  return {
    source,
    target,
    journal,
    attempts,
    setSource: (value: PlaylistSnapshot) => (src = value),
    setAccount: (value: PlaylistAccount) => (account = value),
    retire: () => (current = false),
    owns: () => current,
    writes: () => writes,
    approval: () =>
      new PlaylistCopyApproval(
        planPlaylistCopy(src, remote, { direction: "export" })
      ),
  }
}
describe("provider-neutral playlist previews", () => {
  test("actual Plex provider name declares duplicate-copy limitation while other providers remain compatible", () => {
    const provider: any = {
      name: "Plex",
      cacheScope: "scoped",
      playbackSession: {},
      capabilities: { playlists: true },
    }
    expect(
      providerPlaylistAdapter(provider, { current: () => provider })
        .capabilities.preservesDuplicateCopies
    ).toBe(false)
    provider.name = "Synthetic"
    expect(
      providerPlaylistAdapter(provider, { current: () => provider })
        .capabilities.preservesDuplicateCopies
    ).toBeUndefined()
  })
  test("known duplicate-copy limitation rejects before claim, journal or remote write; compatible adapters still export duplicates", async () => {
    const f = fixture(),
      approval = f.approval()
    f.target.capabilities = {
      ...f.target.capabilities,
      preservesDuplicateCopies: false,
    }
    await expect(
      executePlaylistCopy(approval, f.source, f.target, f.journal, f.owns)
    ).rejects.toThrow("Plex cannot preserve repeated songs")
    expect(f.attempts).toHaveLength(0)
    expect(f.writes()).toBe(0)
    f.target.capabilities = {
      ...f.target.capabilities,
      preservesDuplicateCopies: true,
    }
    expect(
      (
        await executePlaylistCopy(
          approval,
          f.source,
          f.target,
          f.journal,
          f.owns
        )
      ).state
    ).toBe("verified")
    expect(f.writes()).toBe(1)
  })
  test("JSPF round trip keeps repeated recording occurrences and order, private export is explicit", () => {
    const data = toJspf(
      "Copy",
      snapshot().items.map((item) => item.track)
    )
    expect(
      data.playlist.extension["https://musicbrainz.org/doc/jspf#playlist"]
        .public
    ).toBe(false)
    const parsed = fromJspf(
      {
        playlist: {
          ...data.playlist,
          identifier: `https://listenbrainz.org/playlist/${ID}`,
        },
      },
      remote
    )
    expect(parsed.items.map((item) => item.track.recordingMbid)).toEqual([
      A,
      B,
      A,
    ])
    expect(new Set(parsed.items.map((item) => item.occurrenceId)).size).toBe(3)
    expect(
      toJspf(
        "Copy",
        parsed.items.map((item) => item.track)
      )
    ).toEqual(data)
  })
  test("MBIDs beat metadata; different MBIDs, live versions, wrong albums and ambiguous local editions do not silently match", () => {
    expect(matchTrack(track("a"), [track("b", B)]).status).toBe("missing")
    expect(
      matchTrack(track("a", null), [
        { ...track("b", null), title: "Track (Live)" },
      ]).status
    ).toBe("missing")
    expect(
      matchTrack(track("a", null), [
        { ...track("b", null), album: "Other album" },
      ]).status
    ).toBe("missing")
    expect(
      matchTrack(track("a"), [track("a"), track("alternate")]).status
    ).toBe("ambiguous")
    expect(
      matchTrack(track("a"), [track("same"), track("text-only", null)])
    ).toMatchObject({ status: "matched", by: "mbid", track: { id: "same" } })
  })
  test("import resolves every duplicate separately; missing export requires explicit per-occurrence approval", () => {
    const source = snapshot()
    source.items[0].track.recordingMbid = null
    const missing = planPlaylistCopy(source, remote, { direction: "export" })
    expect(() => resolvedTracks(missing)).toThrow(/every missing/)
    const fixed = resolvePlaylistOccurrence(missing, "0", track("explicit"))
    expect(resolvedTracks(fixed).map((item) => item.recordingMbid)).toEqual([
      A,
      B,
      A,
    ])
    expect(missing.rows[0].match.status).toBe("missing")
    const imported = planPlaylistCopy(snapshot(remote), local, {
      direction: "import",
      candidates: [track("local-a"), track("local-b", B)],
    })
    expect(resolvedTracks(imported).map((item) => item.id)).toEqual([
      "local-a",
      "local-b",
      "local-a",
    ])
    expect(Object.isFrozen(imported.rows[0].match)).toBe(true)
  })
  test("conflicts preserve occurrence/order edits and reject retired accounts", () => {
    const source = snapshot(),
      destination = { ...snapshot(remote), id: "destination" },
      baseline = { source, destination }
    expect(playlistLinkChanges(baseline, source, destination)).toBe("unchanged")
    const moved = { ...source, items: [...source.items].reverse() }
    expect(playlistLinkChanges(baseline, moved, destination)).toBe(
      "source-changed"
    )
    expect(
      playlistLinkChanges(baseline, moved, {
        ...destination,
        title: "Remote edit",
      })
    ).toBe("both-changed")
    expect(
      playlistLinkChanges(
        baseline,
        { ...source, account: { ...local, revision: "2" } },
        destination
      )
    ).toBe("retired")
  })
  test("invalid identifiers, oversized lists, conflicting MBIDs and duplicate occurrence IDs fail before writes", () => {
    expect(() =>
      fromJspf(
        {
          playlist: {
            identifier: ID,
            title: "Copy",
            track: [
              {
                identifier: [
                  `https://musicbrainz.org/recording/${A}`,
                  `https://musicbrainz.org/recording/${B}`,
                ],
              },
            ],
          },
        },
        remote
      )
    ).toThrow(/Conflicting/)
    expect(() =>
      fromJspf(
        {
          playlist: {
            identifier: ID,
            title: "Copy",
            track: Array(1001).fill({}),
          },
        },
        remote
      )
    ).toThrow(/limit/)
    expect(() => toJspf("Copy", [track("bad", "../private")])).toThrow(/MBID/)
    const value = snapshot()
    value.items[1].occurrenceId = "0"
    expect(() =>
      planPlaylistCopy(value, remote, { direction: "export" })
    ).toThrow(/unique/)
    expect(lastFmPlaylistCapabilities).toMatchObject({
      read: false,
      createCopy: false,
      replace: false,
    })
  })
})
describe("explicit durable copy admission", () => {
  test("acknowledged create is verified in original order, including duplicate recordings, and approval cannot repeat", async () => {
    const f = fixture(),
      approval = f.approval()
    const result = await executePlaylistCopy(
      approval,
      f.source,
      f.target,
      f.journal,
      f.owns
    )
    expect(result.state).toBe("verified")
    expect(f.writes()).toBe(1)
    expect(f.attempts.map((item) => item.state)).toEqual([
      "admitting",
      "created",
      "verified",
    ])
    await expect(
      executePlaylistCopy(approval, f.source, f.target, f.journal, f.owns)
    ).rejects.toThrow(/already submitted/)
    expect(f.writes()).toBe(1)
  })
  test("changed source, reconnected same user, retired view and failed local retention each stop admission", async () => {
    for (const kind of ["source", "account", "retired", "journal"]) {
      const f = fixture(),
        approval = f.approval()
      if (kind === "source") f.setSource({ ...snapshot(), title: "Edited" })
      if (kind === "account") f.setAccount({ ...remote, revision: "2" })
      if (kind === "retired") f.retire()
      if (kind === "journal")
        f.journal.save = async () => {
          throw Error("storage failed")
        }
      await expect(
        executePlaylistCopy(approval, f.source, f.target, f.journal, f.owns)
      ).rejects.toThrow()
      expect(f.writes()).toBe(0)
    }
  })
  test("retirement during durable admission stops the request; after admission receipt retains original identity", async () => {
    const f = fixture(),
      save = f.journal.save
    f.journal.save = async (attempt) => {
      await save(attempt)
      if (attempt.state === "admitting") f.retire()
    }
    await expect(
      executePlaylistCopy(f.approval(), f.source, f.target, f.journal, f.owns)
    ).rejects.toThrow(/No request/)
    expect(f.writes()).toBe(0)
    expect(f.attempts.at(-1)!.state).toBe("cancelled")
    const g = fixture()
    g.target.createCopy = async () => {
      g.retire()
      return { id: ID }
    }
    const result = await executePlaylistCopy(
      g.approval(),
      g.source,
      g.target,
      g.journal,
      g.owns
    )
    expect(result.state).toBe("created")
    expect(result.account).toEqual(remote)
    expect(result.destinationId).toBe(ID)
  })
  test("unknown remote outcome is retained, cannot repeat, and wrong-account reconciliation cannot replay it", async () => {
    const f = fixture(),
      approval = f.approval()
    f.target.createCopy = async () => {
      throw Error("private-service-body")
    }
    let error: PlaylistCopyError
    try {
      await executePlaylistCopy(approval, f.source, f.target, f.journal, f.owns)
    } catch (value) {
      error = value as PlaylistCopyError
    }
    expect(error!.message).not.toContain("private-service-body")
    expect(error!.attempt.state).toBe("reconcile")
    expect(f.attempts.at(-1)!.state).toBe("reconcile")
    await expect(
      executePlaylistCopy(approval, f.source, f.target, f.journal, f.owns)
    ).rejects.toThrow(/already submitted/)
    f.setAccount({ ...remote, user: "other" })
    await expect(
      reconcilePlaylistAttempt(error!.attempt, f.target, f.journal, ID)
    ).rejects.toThrow(/original/)
  })
  test("remote order loss is surfaced and explicit reconciliation checks every occurrence", async () => {
    const f = fixture(),
      originalRead = f.target.read
    f.target.read = async (id) => {
      const result = await originalRead(id)
      return { ...result, items: result.items.slice(0, 2) }
    }
    const result = await executePlaylistCopy(
      f.approval(),
      f.source,
      f.target,
      f.journal,
      f.owns
    )
    expect(result.state).toBe("reconcile")
    await expect(
      reconcilePlaylistAttempt(result, f.target, f.journal, ID)
    ).rejects.toThrow(/does not match/)
    f.target.read = originalRead
    expect(
      (await reconcilePlaylistAttempt(result, f.target, f.journal, ID)).state
    ).toBe("verified")
  })
  test("receipt persistence failure after create retains its destination ID in a retryable error", async () => {
    const f = fixture()
    f.journal.save = async (attempt) => {
      if (attempt.state !== "admitting") throw Error("storage unavailable")
    }
    try {
      await executePlaylistCopy(
        f.approval(),
        f.source,
        f.target,
        f.journal,
        f.owns
      )
      throw Error("Expected failure")
    } catch (value) {
      expect(value).toBeInstanceOf(PlaylistCopyError)
      expect((value as PlaylistCopyError).attempt.destinationId).toBe(ID)
      expect((value as Error).message).toContain("Keep this view open")
    }
  })
  test("durable journal preserves unknown outcomes, blocks duplicate unknown creates and bounds acknowledged history", () => {
    const attempt: PlaylistAttempt = {
      id: "first",
      account: remote,
      sourceAccount: local,
      sourcePlaylistId: "source",
      title: "Copy",
      createdAt: 0,
      state: "reconcile",
      expectedTrackIds: [A, B, A],
    }
    let items = mergePlaylistAttempt([], attempt)
    expect(() =>
      mergePlaylistAttempt(items, { ...attempt, id: "second" })
    ).toThrow(/previous copy/)
    for (let index = 0; index < 100; index++)
      items = mergePlaylistAttempt(items, {
        ...attempt,
        id: String(index),
        title: String(index),
        state: "verified",
      })
    expect(items.length).toBe(33)
    expect(items[0].id).toBe("first")
    expect(() =>
      mergePlaylistAttempt(items, {
        ...attempt,
        account: { ...remote, user: "other" },
      })
    ).toThrow(/account changed/)
  })
})
describe("real adapters with synthetic transport/provider", () => {
  test("ListenBrainz API adapter carries captured account for pages, reads and create, while refusing stale same-user revisions", async () => {
    let account = remote,
      requests: unknown[] = []
    const data = {
      playlist: {
        ...toJspf(
          "Copy",
          snapshot().items.map((item) => item.track)
        ).playlist,
        identifier: `https://listenbrainz.org/playlist/${ID}`,
      },
    }
    const adapter = listenBrainzPlaylistAdapter(remote, {
      account: async () => account,
      list: async (...args) => {
        requests.push(args)
        return {
          playlists: [{ playlist: { ...data.playlist, track: [] } }],
          count: 50,
          offset: 0,
          playlist_count: 1,
        }
      },
      read: async (...args) => {
        requests.push(args)
        return data
      },
      create: async (...args) => {
        requests.push(args)
        return { id: ID }
      },
    })
    expect((await adapter.list()).total).toBe(1)
    expect((await adapter.read(ID)).items.length).toBe(3)
    expect(
      await adapter.createCopy(
        "Copy",
        snapshot().items.map((item) => item.track),
        remote
      )
    ).toEqual({ id: ID })
    expect(requests[2]).toEqual([remote, "Copy", [A, B, A]])
    account = { ...remote, revision: "2" }
    await expect(adapter.read(ID)).rejects.toThrow(/account changed/)
    await expect(adapter.createCopy("Copy", [], remote)).rejects.toThrow(
      /account changed/
    )
    expect(requests.length).toBe(3)
  })
  test("library adapter pages every ordered occurrence, sends repeat IDs unchanged and fences provider replacement", async () => {
    let current: any,
      sent: string[] = []
    const provider: any = {
      name: "Synthetic",
      cacheScope: "opaque",
      capabilities: { playlists: true },
      getPlaylists: async () => [{ id: "source", title: "Copy" }],
      getPlaylistItems: async () => ({
        items: ["a", "b", "a"].map((id, index) => ({
          id,
          title: "Track",
          artistName: "Artist",
          albumName: "Album",
          duration: 100000,
          playlistItemId: String(index),
        })),
        total: 3,
        offset: 0,
      }),
      createPlaylist: async (_title, ids) => {
        sent = ids
        return { id: "created" }
      },
    }
    current = provider
    const adapter = providerPlaylistAdapter(provider, {
      current: () => current,
      verifiedMbid: () => A,
    })
    const account = await adapter.account(),
      result = await adapter.read("source")
    expect(result.items.map((item) => item.track.id)).toEqual(["a", "b", "a"])
    await adapter.createCopy(
      "Copy",
      result.items.map((item) => item.track),
      account
    )
    expect(sent).toEqual(["a", "b", "a"])
    current = { ...provider }
    await expect(adapter.read("source")).rejects.toThrow(/account changed/)
    await expect(adapter.createCopy("Copy", [], account)).rejects.toThrow(
      /account changed/
    )
  })
  test("partial/repeated/changing-total provider pages cannot become a ready preview", async () => {
    const provider: any = {
      name: "Synthetic",
      cacheScope: "opaque",
      capabilities: { playlists: true },
      getPlaylists: async () => [{ id: "source", title: "Copy" }],
      getPlaylistItems: async () => ({ items: [], total: 2, offset: 0 }),
    }
    const adapter = providerPlaylistAdapter(provider, {
      current: () => provider,
    })
    await expect(adapter.read("source")).rejects.toThrow(/Incomplete/)
    provider.getPlaylistItems = async () => ({
      items: [],
      total: 1001,
      offset: 0,
    })
    await expect(adapter.read("source")).rejects.toThrow(/oversized/)
    provider.getPlaylistItems = async () => ({
      items: [],
      total: 0,
      offset: 100,
    })
    await expect(adapter.read("source")).rejects.toThrow(/Invalid/)
  })
})
describe("restart/reconnect receipt identity", () => {
  test("same-account renewed auth does not permit replay but allows explicit read-only verification", async () => {
    const f = fixture()
    f.target.createCopy = async () => {
      throw Error("unknown")
    }
    let receipt: PlaylistAttempt
    try {
      await executePlaylistCopy(
        f.approval(),
        f.source,
        f.target,
        f.journal,
        f.owns
      )
    } catch (error) {
      receipt = (error as PlaylistCopyError).attempt
    }
    const renewed = { ...remote, revision: "2" }
    f.setAccount(renewed)
    expect(() =>
      mergePlaylistAttempt([receipt!], {
        ...receipt!,
        id: "new-attempt",
        account: renewed,
        state: "admitting",
      })
    ).toThrow(/previous copy/)
    const result = await reconcilePlaylistAttempt(
      receipt!,
      f.target,
      f.journal,
      ID
    )
    expect(result.state).toBe("verified")
    expect(result.account.revision).toBe("1")
  })
  test("stable local identity survives adapter recreation, while same-provider connection replacement retires old adapters", async () => {
    const provider: any = {
      name: "Synthetic",
      cacheScope: "opaque",
      playbackSession: {},
      capabilities: { playlists: true },
      createPlaylist: async () => ({ id: "copy" }),
    }
    const old = providerPlaylistAdapter(provider, { current: () => provider }),
      original = await old.account()
    provider.playbackSession = {}
    await expect(old.account()).rejects.toThrow(/account changed/)
    const fresh = providerPlaylistAdapter(provider, { current: () => provider })
    expect(await fresh.account()).toEqual(original)
    const receipt: PlaylistAttempt = {
      id: "one",
      account: original,
      sourceAccount: remote,
      sourcePlaylistId: ID,
      title: "Copy",
      expectedTrackIds: ["a", "a"],
      createdAt: 0,
      state: "admitting",
    }
    expect(() =>
      mergePlaylistAttempt([receipt], {
        ...receipt,
        id: "two",
        account: { ...original },
      })
    ).toThrow(/previous copy/)
  })
  test("settled receipts cannot be downgraded by late errors or moved to a different destination", () => {
    const receipt: PlaylistAttempt = {
      id: "one",
      account: remote,
      sourceAccount: local,
      sourcePlaylistId: "source",
      title: "Copy",
      expectedTrackIds: [A],
      destinationId: ID,
      createdAt: 0,
      state: "verified",
    }
    expect(() =>
      mergePlaylistAttempt([receipt], { ...receipt, state: "reconcile" })
    ).toThrow(/settled/)
    expect(() =>
      mergePlaylistAttempt([receipt], { ...receipt, destinationId: A })
    ).toThrow(/destination changed/)
  })
})
describe("ordered adapter round trips", () => {
  test("ListenBrainz-to-library copy and library-to-ListenBrainz copy preserve every occurrence through actual adapters", async () => {
    const music = ["a", "b", "a"].map((id, index) => ({
      id,
      title: "Track",
      artistName: "Artist",
      albumName: "Album",
      duration: 100000,
      playlistItemId: String(index),
    }))
    let createdIds: string[] = [],
      playlistPresent = false
    const provider: any = {
      name: "Synthetic",
      cacheScope: "opaque",
      capabilities: { playlists: true },
      getPlaylists: async () =>
        playlistPresent ? [{ id: "local-copy", title: "Copy" }] : [],
      getPlaylistItems: async () => ({ items: music, total: 3, offset: 0 }),
      createPlaylist: async (_title, ids) => {
        createdIds = ids
        playlistPresent = true
        return { id: "local-copy" }
      },
    }
    let data = {
        playlist: {
          ...toJspf(
            "Copy",
            snapshot().items.map((item) => item.track)
          ).playlist,
          identifier: `https://listenbrainz.org/playlist/${ID}`,
        },
      },
      sentMbids: readonly string[] = []
    const lb = listenBrainzPlaylistAdapter(remote, {
      account: async () => remote,
      list: async () => ({
        playlists: [],
        count: 50,
        offset: 0,
        playlist_count: 0,
      }),
      read: async () => data,
      create: async (_account, title, mbids) => {
        sentMbids = mbids
        data = {
          playlist: {
            ...toJspf(
              title,
              mbids.map((id) => track(id, id))
            ).playlist,
            identifier: `https://listenbrainz.org/playlist/${ID}`,
          },
        }
        return { id: ID }
      },
    })
    const library = providerPlaylistAdapter(provider, {
      current: () => provider,
      verifiedMbid: (item) => (item.id === "a" ? A : B),
    })
    const journal = {
      save: async (_attempt: PlaylistAttempt) => {},
      list: async () => [],
    }
    const candidates = [track("a"), track("b", B)]
    const importedPlan = planPlaylistCopy(
      await lb.read(ID),
      await library.account(),
      { direction: "import", candidates }
    )
    const imported = await executePlaylistCopy(
      new PlaylistCopyApproval(importedPlan),
      lb,
      library,
      journal,
      () => true
    )
    expect(imported.state).toBe("verified")
    expect(createdIds).toEqual(["a", "b", "a"])
    const exportedPlan = planPlaylistCopy(
      await library.read(imported.destinationId!),
      remote,
      { direction: "export" }
    )
    const exported = await executePlaylistCopy(
      new PlaylistCopyApproval(exportedPlan),
      library,
      lb,
      journal,
      () => true
    )
    expect(exported.state).toBe("verified")
    expect(sentMbids).toEqual([A, B, A])
  })
  test("multi-page local playlists retain repeated tracks across page boundaries", async () => {
    const all = Array.from({ length: 121 }, (_, index) => ({
        id: index % 2 ? "b" : "a",
        title: "Track",
        artistName: "Artist",
        albumName: "Album",
        duration: 100000,
        playlistItemId: `occurrence-${index}`,
      })),
      offsets: number[] = []
    const provider: any = {
      name: "Synthetic",
      cacheScope: "opaque",
      capabilities: { playlists: true },
      getPlaylists: async () => [{ id: "source", title: "Copy" }],
      getPlaylistItems: async (_id, offset, limit) => {
        offsets.push(offset)
        return {
          items: all.slice(offset, offset + limit),
          total: all.length,
          offset,
        }
      },
    }
    const library = providerPlaylistAdapter(provider, {
      current: () => provider,
    })
    const result = await library.read("source")
    expect(offsets).toEqual([0, 100])
    expect(result.items.map((item) => item.track.id)).toEqual(
      all.map((item) => item.id)
    )
    expect(new Set(result.items.map((item) => item.occurrenceId)).size).toBe(
      121
    )
  })
})
describe("explicit unknown-outcome dismissal", () => {
  const attempt: PlaylistAttempt = {
    id: "unknown",
    account: remote,
    sourceAccount: local,
    sourcePlaylistId: "source",
    title: "Copy",
    expectedTrackIds: [A, B, A],
    createdAt: 0,
    state: "admitting",
  }
  test("unchecked risk or retired/wrong/revised account cannot dismiss; acknowledged disposition is local-only and restart-safe", async () => {
    const f = fixture()
    await expect(
      dismissUnknownPlaylistAttempt(attempt, f.target, f.journal, f.owns, false)
    ).rejects.toThrow(/acknowledge/)
    f.setAccount({ ...remote, user: "other" })
    await expect(
      dismissUnknownPlaylistAttempt(attempt, f.target, f.journal, f.owns, true)
    ).rejects.toThrow(/original/)
    f.setAccount(remote)
    f.retire()
    await expect(
      dismissUnknownPlaylistAttempt(attempt, f.target, f.journal, f.owns, true)
    ).rejects.toThrow(/original/)
    const g = fixture()
    let accounts = 0
    g.target.account = async () => ({ ...remote, revision: String(++accounts) })
    await expect(
      dismissUnknownPlaylistAttempt(attempt, g.target, g.journal, g.owns, true)
    ).rejects.toThrow(/Account changed/)
    const h = fixture(),
      dismissed = await dismissUnknownPlaylistAttempt(
        attempt,
        h.target,
        h.journal,
        h.owns,
        true
      )
    expect(h.writes()).toBe(0)
    expect(dismissed.state).toBe("dismissed")
    expect(dismissed.dismissedAt).toBeGreaterThan(0)
    expect(dismissed.dismissalReason).toBe("manual-unknown-outcome")
    expect(dismissed.account).toEqual(remote)
    const restarted = mergePlaylistAttempt([], dismissed)
    expect(
      mergePlaylistAttempt(restarted, {
        ...attempt,
        id: "deliberate-next-preview",
      }).length
    ).toBe(2)
    expect(() =>
      mergePlaylistAttempt(restarted, { ...attempt, state: "reconcile" })
    ).toThrow(/dismissed locally/)
  })
  test("failed dismissal retention keeps original unknown receipt blocked, exposes a local-only retryable error", async () => {
    const f = fixture()
    f.journal.save = async () => {
      throw Error("private-storage-detail")
    }
    try {
      await dismissUnknownPlaylistAttempt(
        attempt,
        f.target,
        f.journal,
        f.owns,
        true
      )
      throw Error("Expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(PlaylistCopyError)
      expect((error as PlaylistCopyError).attempt.dismissalReason).toBe(
        "manual-unknown-outcome"
      )
      expect((error as Error).message).not.toContain("private-storage-detail")
    }
    expect(f.writes()).toBe(0)
    expect(() =>
      mergePlaylistAttempt([attempt], { ...attempt, id: "retry-remote" })
    ).toThrow(/previous copy/)
  })
})
