/** Production linked execution exercised only against bridge-created QA objects.
 * This module never loads credentials or accepts arbitrary playlist IDs. */
import {
  checkLinkedPlaylist,
  reconcileLinkedStep,
} from "../../../src/playlistSync/linkedExecution"
import {
  providerPlaylistAdapter,
  providerPlaylistAccount,
} from "../../../src/playlistSync/provider"
import { listenBrainzPlaylistAdapter } from "../../../src/playlistSync/listenbrainz"
import { fromJspf } from "../../../src/playlistSync/jspf"
import { retainLink } from "../../../src/playlistSync/linkedJournal"
import {
  mapLinkedTracks,
  type LinkedPlaylist,
  type SequenceOperation,
} from "../../../src/playlistSync/linked"
import type {
  PlaylistSnapshot,
  PlaylistAccount,
  PlaylistTrack,
} from "../../../src/playlistSync/types"
import type { MusicProvider } from "../../../src/providers/types"
import type { MusicTrack } from "../../../src/types/music"

export interface LiveSmokeTransport {
  request<T>(action: string, payload?: unknown): Promise<T>
}
interface Session {
  runId: string
  title: string
  libraryId: string
  remoteId: string
  libraryAccount: PlaylistAccount
  remoteAccount: PlaylistAccount
  initialLayout?: "duplicate" | "distinct"
  tracks: {
    libraryTrack: PlaylistTrack
    recordingMbid: string
    verifiedBy: "provider-mbid"
  }[]
}
export async function runLivePlaylistSmoke(bridge: LiveSmokeTransport) {
  const session = await bridge.request<Session>("session")
  if (
    !/^[0-9a-f-]{36}$/.test(session.runId) ||
    session.title !== `Hibiki QA ${session.runId}` ||
    session.tracks.length !== 3
  )
    throw Error("Unreviewed QA session")
  const ids = session.tracks.map((item) => item.libraryTrack.id),
    mbids = session.tracks.map((item) => item.recordingMbid)
  if (new Set(ids).size !== 3 || new Set(mbids).size !== 3)
    throw Error("Distinct verified tracks required")
  const distinct = session.initialLayout === "distinct"
  let active = true,
    remoteWrites = 0,
    libraryWrites = 0,
    rows: LinkedPlaylist[] = []
  const readLibrary = () => bridge.request<PlaylistSnapshot>("library.read")
  const readRemote = () => bridge.request<unknown>("remote.read")
  const provider = {
    name: session.libraryAccount.service.slice("library:".length),
    cacheScope: session.libraryAccount.user,
    playbackSession: 1,
    capabilities: { playlists: true },
    getPlaylists: async () => {
      const value = await readLibrary()
      return [
        {
          id: value.id,
          title: value.title,
          smart: false,
          trackCount: value.items.length,
        },
      ]
    },
    getPlaylistItems: async (id: string, offset: number, limit: number) => {
      if (id !== session.libraryId) throw Error("Unowned QA playlist")
      const value = await readLibrary()
      return {
        total: value.items.length,
        offset,
        items: value.items.slice(offset, offset + limit).map(
          (item) =>
            ({
              id: item.track.id,
              title: item.track.title,
              artistName: item.track.artist,
              albumName: item.track.album ?? "",
              duration: item.track.durationMs ?? 0,
              playlistItemId: item.occurrenceId,
            }) as MusicTrack
        ),
      }
    },
  } as unknown as MusicProvider
  const local = providerPlaylistAdapter(provider, {
    current: () => (active ? provider : null),
    verifiedMbid: (track) =>
      session.tracks.find((item) => item.libraryTrack.id === track.id)
        ?.recordingMbid ?? null,
  })
  const remoteTransport = {
    account: () => bridge.request<PlaylistAccount>("remote.account"),
    read: async (_account: PlaylistAccount, id: string) => {
      if (id !== session.remoteId) throw Error("Unowned QA playlist")
      return readRemote()
    },
    create: async () => {
      throw Error("No arbitrary QA create")
    },
    list: async () => {
      throw Error("No QA scan")
    },
  }
  const remote = listenBrainzPlaylistAdapter(
    session.remoteAccount,
    remoteTransport
  )
  const repository = {
    load: async () => structuredClone(rows),
    save: async (link: LinkedPlaylist, revision: number | null) => {
      const next = retainLink(rows, link, revision)
      await bridge.request("journal.retain", next)
      rows = next
      return structuredClone(next.find((item) => item.id === link.id)!)
    },
  }
  const services = {
    repository,
    current: () => active,
    library: {
      account: local.account,
      read: local.read,
      mutate: async (
        before: PlaylistSnapshot,
        operation: SequenceOperation
      ) => {
        libraryWrites++
        await bridge.request("library.mutate", { before, operation })
        return local.read(session.libraryId)
      },
    },
    listenbrainz: {
      account: remote.account,
      read: remote.read,
      mutate: async (
        before: PlaylistSnapshot,
        operation: SequenceOperation
      ) => {
        remoteWrites++
        return fromJspf(
          await bridge.request("remote.mutate", { before, operation }),
          session.remoteAccount
        )
      },
    },
  }
  const sequence = (snapshot: PlaylistSnapshot) =>
    snapshot.items.map((item) => item.track.id)
  const equal = (actual: readonly string[], expected: readonly string[]) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error("Ordered duplicate proof failed")
  }
  let library = await local.read(session.libraryId),
    remoteValue = await remote.read(session.remoteId)
  equal(
    sequence(library),
    distinct ? [ids[0], ids[1]] : [ids[0], ids[1], ids[0]]
  )
  equal(
    sequence(remoteValue),
    distinct ? [mbids[0], mbids[1]] : [mbids[0], mbids[1], mbids[0]]
  )
  let link: LinkedPlaylist = {
    version: 1,
    id: `qa-${session.runId}`,
    revision: 0,
    library: providerPlaylistAccount(provider),
    listenbrainz: session.remoteAccount,
    libraryPlaylistId: session.libraryId,
    listenbrainzPlaylistId: session.remoteId,
    enabled: true,
    paused: false,
    direction: "bidirectional",
    automatic: false,
    state: "ready",
    baseline: { library, listenbrainz: remoteValue },
    mappings: session.tracks,
  }
  link = await repository.save(link, null)
  await bridge.request("proof.stage", {
    name: distinct ? "initial-distinct-order" : "initial-duplicate-order",
    libraryItems: distinct ? 2 : 3,
    remoteItems: distinct ? 2 : 3,
  })
  // Controlled source-side change to only our newly-created Plex playlist.
  await services.library.mutate(library, { kind: "append", trackId: ids[2] })
  link = await checkLinkedPlaylist(link, services, 5)
  if (link.job || link.state !== "ready")
    throw Error("Library-to-ListenBrainz update unconfirmed")
  equal(
    sequence(await remote.read(session.remoteId)),
    distinct
      ? [mbids[0], mbids[1], mbids[2]]
      : [mbids[0], mbids[1], mbids[0], mbids[2]]
  )
  await bridge.request("proof.stage", {
    name: "library-to-listenbrainz",
    orderedItems: distinct ? 3 : 4,
  })
  remoteValue = await remote.read(session.remoteId)
  await services.listenbrainz.mutate(remoteValue, {
    kind: "move",
    from: distinct ? 2 : 3,
    to: distinct ? 0 : 1,
  })
  link = await checkLinkedPlaylist(link, services, 5)
  if (link.job || link.state !== "ready")
    throw Error("ListenBrainz-to-library update unconfirmed")
  equal(
    sequence(await local.read(session.libraryId)),
    distinct ? [ids[2], ids[0], ids[1]] : [ids[0], ids[2], ids[1], ids[0]]
  )
  await bridge.request("proof.stage", {
    name: "listenbrainz-to-library",
    orderedItems: distinct ? 3 : 4,
  })
  library = await local.read(session.libraryId)
  remoteValue = await remote.read(session.remoteId)
  await services.library.mutate(
    library,
    distinct
      ? { kind: "move", from: 1, to: 0 }
      : { kind: "append", trackId: ids[1] }
  )
  await services.listenbrainz.mutate(
    remoteValue,
    distinct
      ? { kind: "move", from: 2, to: 1 }
      : { kind: "append", trackId: mbids[2] }
  )
  const count = libraryWrites + remoteWrites
  link = await checkLinkedPlaylist(link, services, 5)
  if (
    link.state !== "conflict" ||
    !link.paused ||
    libraryWrites + remoteWrites !== count
  )
    throw Error("Both-sided changes were not paused without writes")
  await bridge.request("proof.stage", {
    name: "both-sided-conflict",
    additionalWrites: 0,
  })
  // Explicit QA plan chooses the current library sequence for a simulated lost
  // frontend acknowledgement. Native HTTP acknowledgement itself is not forged.
  library = await local.read(session.libraryId)
  remoteValue = await remote.read(session.remoteId)
  const mapped = mapLinkedTracks("library", library, link.mappings)
  if (mapped.missing.length) throw Error("Reviewed QA recording mapping failed")
  const desired = mapped.desired
  link = await repository.save(
    {
      ...link,
      paused: false,
      state: "ready",
      job: {
        id: `qa-recovery-${session.runId}`,
        source: "library",
        sourceSnapshot: library,
        destinationSnapshot: remoteValue,
        desired,
        completedSteps: 0,
      },
    },
    link.revision
  )
  const actualMutate = services.listenbrainz.mutate
  services.listenbrainz.mutate = async (...args) => {
    await actualMutate(...args)
    throw Error(
      "QA simulated frontend acknowledgement loss after native verified write"
    )
  }
  link = await checkLinkedPlaylist(link, services, 5)
  services.listenbrainz.mutate = actualMutate
  if (link.state !== "unknown" || !link.paused || !link.job?.step)
    throw Error("Lost acknowledgement was not retained")
  const beforeRecovery = libraryWrites + remoteWrites
  const recovered = await reconcileLinkedStep(link, services)
  if (
    recovered.job?.step ||
    !recovered.paused ||
    recovered.history?.at(-1)?.state !== "verified" ||
    libraryWrites + remoteWrites !== beforeRecovery
  )
    throw Error("Read-only acknowledgement reconciliation failed")
  await bridge.request("proof.stage", {
    name: "simulated-ack-loss-read-only-recovery",
    additionalWrites: 0,
  })
  active = false
  return {
    stages: 5,
    libraryOccurrenceWrites: libraryWrites,
    remoteOccurrenceWrites: remoteWrites,
    retainedPaused: true,
  }
}
