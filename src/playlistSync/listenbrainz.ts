import type { SequenceOperation } from "./linked"
import { invoke } from "@tauri-apps/api/core"
import { fromJspf, playlistId } from "./jspf"
import { recordingMbid } from "./matching"
import { sameAccount } from "./types"
import type {
  PlaylistAccount,
  PlaylistAdapter,
  PlaylistSnapshot,
} from "./types"
export type ListenBrainzListingSource =
  "created" | "createdfor" | "collaborator"
export interface ListenBrainzPlaylistSummary extends PlaylistSnapshot {
  weekly?: import("./weekly").WeeklyMetadata
  access: {
    origins: ListenBrainzListingSource[]
    creator: string | null
    owned: boolean
    writable: boolean
    generated: boolean
  }
}
/** Family identity comes only from the verified bot's created-for metadata.
 * The upstream title suffix is optional display text, never source identity. */
export function weeklyPlaylistMetadata(
  value: unknown,
  source: ListenBrainzListingSource,
  expected: PlaylistAccount
): import("./weekly").WeeklyMetadata | undefined {
  const playlist = (value as any)?.playlist
  const extension =
    playlist?.extension?.["https://musicbrainz.org/doc/jspf#playlist"]
  const family =
    extension?.additional_metadata?.algorithm_metadata?.source_patch
  if (
    source !== "createdfor" ||
    playlist?.creator !== "listenbrainz" ||
    extension?.created_for !== expected.user ||
    !["weekly-exploration", "weekly-jams"].includes(family)
  )
    return undefined
  const createdAt = playlist.date
  if (
    typeof createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      createdAt
    ) ||
    !Number.isFinite(Date.parse(createdAt))
  )
    return undefined
  const calendarDate = new Date(`${createdAt.slice(0, 10)}T00:00:00Z`)
  if (
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== createdAt.slice(0, 10) ||
    Number(createdAt.slice(11, 13)) > 23 ||
    Number(createdAt.slice(14, 16)) > 59 ||
    Number(createdAt.slice(17, 19)) > 59
  )
    return undefined
  const match =
    typeof playlist.title === "string" &&
    /, week of (\d{4}-\d{2}-\d{2}) Mon$/.exec(playlist.title)
  let weekOf: string | null = null
  if (match) {
    const date = new Date(`${match[1]}T00:00:00Z`)
    if (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === match[1] &&
      date.getUTCDay() === 1
    )
      weekOf = match[1]
  }
  return { family, recipient: expected.user, createdAt, weekOf }
}
export interface ListenBrainzPlaylistListing {
  items: ListenBrainzPlaylistSummary[]
  total: number
  complete: boolean
  truncated: boolean
}
export interface ListenBrainzPlaylistTransport {
  account(): Promise<PlaylistAccount>
  list(
    expected: PlaylistAccount,
    offset: number,
    count: number,
    source?: ListenBrainzListingSource
  ): Promise<{
    playlists: unknown[]
    playlist_count: number
    offset: number
    count: number
    listing_source?: ListenBrainzListingSource
  }>
  read(expected: PlaylistAccount, id: string): Promise<unknown>
  mutate?(
    expected: PlaylistAccount,
    id: string,
    before: { title: string; mbids: string[] },
    operation: SequenceOperation
  ): Promise<unknown>
  create(
    expected: PlaylistAccount,
    title: string,
    mbids: readonly string[]
  ): Promise<{ id: string }>
  describe?(expected: PlaylistAccount, before: PlaylistSnapshot, title: string, description: string): Promise<unknown>
}
export const nativeListenBrainzPlaylists: ListenBrainzPlaylistTransport = {
  account: () => invoke("playlist_sync_listenbrainz_account"),
  list: (expected, offset, count, source = "created") =>
    invoke("playlist_sync_listenbrainz_list", {
      expected,
      offset,
      count,
      source,
    }),
  read: (expected, id) =>
    invoke("playlist_sync_listenbrainz_read", { expected, id }),
  mutate: (expected, id, before, operation) =>
    invoke("playlist_sync_listenbrainz_mutate", {
      expected,
      id,
      before,
      operation,
    }),
  create: (expected, title, mbids) =>
    invoke("playlist_sync_listenbrainz_create", { expected, title, mbids }),
  describe: (expected, before, title, description) => invoke("playlist_sync_listenbrainz_describe", {
    expected, id: before.id, before: { title: before.title, mbids: before.items.map(row => row.track.recordingMbid) },
    expectedDescription: before.description ?? "", title, description,
  }),
}
/** An adapter stays bound to the exact preview account, including reconnects to the same username. */
export function listenBrainzPlaylistAdapter(
  expected: PlaylistAccount,
  transport = nativeListenBrainzPlaylists
): PlaylistAdapter & {
  list(
    offset?: number,
    count?: number,
    source?: ListenBrainzListingSource
  ): Promise<{ items: ListenBrainzPlaylistSummary[]; total: number }>
  listAll(): Promise<ListenBrainzPlaylistListing>
} {
  async function owns() {
    if (!sameAccount(await transport.account(), expected))
      throw Error("ListenBrainz account changed. Preview again.")
  }
  function summary(
    value: unknown,
    source: ListenBrainzListingSource
  ): ListenBrainzPlaylistSummary {
    const snapshot = fromJspf(value, expected)
    if (snapshot.items.length)
      throw Error("Playlist summary unexpectedly contains recordings")
    const creator = (value as any)?.playlist?.creator
    if (
      creator != null &&
      (typeof creator !== "string" || creator.length > 500)
    )
      throw Error("Invalid playlist creator")
    const generated = source === "createdfor"
    const owned =
      typeof creator === "string" && creator === expected.user && !generated
    return {
      ...snapshot,
      weekly: weeklyPlaylistMetadata(value, source, expected),
      access: {
        origins: [source],
        creator: creator ?? null,
        owned,
        writable: owned,
        generated,
      },
    }
  }
  async function list(
    offset = 0,
    count = 50,
    source: ListenBrainzListingSource = "created"
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 100 ||
      !["created", "createdfor", "collaborator"].includes(source)
    )
      throw Error("Invalid playlist page")
    await owns()
    const result = await transport.list(expected, offset, count, source)
    await owns()
    if (
      (result.listing_source !== undefined &&
        result.listing_source !== source) ||
      (source !== "created" && result.listing_source === undefined)
    )
      throw Error("Restart Hibiki to load all ListenBrainz playlist feeds")
    if (
      !Array.isArray(result.playlists) ||
      result.playlists.length > count ||
      !Number.isSafeInteger(result.playlist_count) ||
      result.playlist_count < 0 ||
      result.offset !== offset ||
      result.playlists.length + offset > result.playlist_count
    )
      throw Error("Invalid playlist page response")
    return {
      items: result.playlists.map((value) => summary(value, source)),
      total: result.playlist_count,
    }
  }
  async function listAll(): Promise<ListenBrainzPlaylistListing> {
    const items = new Map<string, ListenBrainzPlaylistSummary>()
    let pages = 0,
      seenRows = 0,
      truncated = false
    for (const source of ["created", "createdfor", "collaborator"] as const) {
      let offset = 0,
        total: number | undefined
      const seen = new Set<string>()
      do {
        if (pages >= 60 || seenRows >= 6000 || items.size >= 2000) {
          truncated = true
          break
        }
        const page = await list(offset, 100, source)
        pages++
        seenRows += page.items.length
        if (total !== undefined && total !== page.total)
          throw Error("ListenBrainz playlists changed while loading. Retry.")
        total = page.total
        if (!page.items.length && offset < total)
          throw Error("Incomplete ListenBrainz playlist listing")
        for (const item of page.items) {
          if (seen.has(item.id))
            throw Error("Repeated ListenBrainz playlist page")
          seen.add(item.id)
          const old = items.get(item.id)
          if (old) {
            if (
              old.access.creator !== item.access.creator ||
              old.title !== item.title
            )
              throw Error("ListenBrainz playlist changed between lists. Retry.")
            old.access.origins.push(source)
            if (item.weekly) {
              if (
                old.weekly &&
                JSON.stringify(old.weekly) !== JSON.stringify(item.weekly)
              )
                throw Error("Weekly playlist changed between lists. Retry.")
              old.weekly = item.weekly
            }
            old.access.generated ||= item.access.generated
            // A generated source is never a writable destination, even if another
            // feed accidentally lists it as owned. Collaborators remain read-only.
            old.access.writable = old.access.owned && !old.access.generated
          } else if (items.size < 2000) items.set(item.id, item)
          else truncated = true
        }
        offset += page.items.length
      } while (offset < (total ?? 0))
      if (truncated) break
    }
    await owns()
    return {
      items: [...items.values()],
      total: items.size,
      complete: !truncated,
      truncated,
    }
  }
  return {
    capabilities: { read: true, createCopy: true, replace: false },
    account: () => transport.account(),
    read: async (id) => {
      await owns()
      const value = await transport.read(expected, playlistId(id))
      await owns()
      return fromJspf(value, expected)
    },
    list,
    listAll,
    createCopy: async (title, tracks, account) => {
      if (
        account.service !== expected.service ||
        account.user !== expected.user ||
        account.revision !== expected.revision
      )
        throw Error("Playlist account changed")
      await owns()
      const mbids = tracks.map((track) => {
        const mbid = recordingMbid(track.recordingMbid)
        if (!mbid)
          throw Error("Export requires a recording MBID for every occurrence")
        return mbid
      })
      const created = await transport.create(expected, title, mbids)
      return { id: playlistId(created.id) }
    },
  }
}
