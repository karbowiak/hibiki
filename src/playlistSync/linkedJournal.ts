import { get, update } from "idb-keyval"
import { playlistJournalDatabase } from "./journal"
import { samePlaylistIdentity } from "./types"
import { validateSnapshot } from "./planner"
import type { LinkedPlaylist } from "./linked"
const KEY = "linked-playlists-v1"
export interface LinkedPlaylistRepository {
  load(): Promise<LinkedPlaylist[]>
  rebind?(
    link: LinkedPlaylist,
    expectedRevision: number,
    newLibrary: LinkedPlaylist["library"]
  ): Promise<LinkedPlaylist>
  save(
    link: LinkedPlaylist,
    expectedRevision: number | null
  ): Promise<LinkedPlaylist>
}
export function validateLinks(links: LinkedPlaylist[]) {
  if (!Array.isArray(links) || links.length > 16)
    throw Error("Invalid linked playlist settings")
  const ids = new Set<string>()
  for (const link of links) {
    if (
      link.version !== 1 ||
      !link.id ||
      link.id.length > 128 ||
      ids.has(link.id) ||
      !Number.isSafeInteger(link.revision) ||
      link.revision < 0 ||
      typeof link.enabled !== "boolean" ||
      typeof link.paused !== "boolean" ||
      link.mappings.length > 1000
    )
      throw Error("Invalid linked playlist settings")
    ids.add(link.id)
    validateSnapshot(link.baseline.library)
    validateSnapshot(link.baseline.listenbrainz)
    if (link.job) {
      validateSnapshot(link.job.sourceSnapshot)
      validateSnapshot(link.job.destinationSnapshot)
      if (
        link.job.desired.length > 1000 ||
        (link.job.step?.afterIds.length ?? 0) > 1000
      )
        throw Error("Invalid sync recovery state")
    }
  }
  return links
}
export function retainLink(
  previous: LinkedPlaylist[],
  link: LinkedPlaylist,
  expectedRevision: number | null
): LinkedPlaylist[] {
  validateLinks(previous)
  const existing = previous.find((item) => item.id === link.id)
  if (
    expectedRevision === null
      ? !!existing
      : existing?.revision !== expectedRevision
  )
    throw Error("Linked playlist changed. Review again.")
  if (
    existing &&
    (!samePlaylistIdentity(existing.library, link.library) ||
      !samePlaylistIdentity(existing.listenbrainz, link.listenbrainz) ||
      existing.libraryPlaylistId !== link.libraryPlaylistId ||
      existing.listenbrainzPlaylistId !== link.listenbrainzPlaylistId)
  )
    throw Error("Linked playlist ownership cannot change")
  if (
    !existing &&
    previous.some(
      (item) =>
        (samePlaylistIdentity(item.library, link.library) &&
          item.libraryPlaylistId === link.libraryPlaylistId) ||
        (samePlaylistIdentity(item.listenbrainz, link.listenbrainz) &&
          item.listenbrainzPlaylistId === link.listenbrainzPlaylistId)
    )
  )
    throw Error(
      "A playlist is already linked. Pause or review its existing link."
    )
  const next = structuredClone({
    ...link,
    revision: (existing?.revision ?? -1) + 1,
  })
  return validateLinks([
    ...previous.filter((item) => item.id !== link.id),
    next,
  ])
}
export function retainReboundLink(
  previous: LinkedPlaylist[],
  id: string,
  expectedRevision: number,
  newLibrary: LinkedPlaylist["library"]
): LinkedPlaylist[] {
  validateLinks(previous)
  const current = previous.find((link) => link.id === id)
  if (
    !current ||
    current.revision !== expectedRevision ||
    current.library.service !== newLibrary.service ||
    current.job?.step
  )
    throw Error(
      "Review the original connection and unresolved operation before rebinding"
    )
  if (
    previous.some(
      (link) =>
        link.id !== id &&
        samePlaylistIdentity(link.library, newLibrary) &&
        link.libraryPlaylistId === current.libraryPlaylistId
    )
  )
    throw Error("Current playlist is already linked")
  const next: LinkedPlaylist = {
    ...current,
    library: structuredClone(newLibrary),
    revision: current.revision + 1,
    paused: true,
    state: "conflict",
    message:
      "Connection identity rebound after explicit review. Preview both current versions before enabling again.",
    job: undefined,
    previousLibraryOwners: [
      ...(current.previousLibraryOwners ?? []),
      current.library,
    ].slice(-16),
  }
  return validateLinks(previous.map((link) => (link.id === id ? next : link)))
}
export const linkedPlaylistRepository: LinkedPlaylistRepository = {
  rebind: async (link, expectedRevision, newLibrary) => {
    let retained: LinkedPlaylist | undefined
    await update<LinkedPlaylist[]>(
      KEY,
      (previous) => {
        const next = retainReboundLink(
          previous ?? [],
          link.id,
          expectedRevision,
          newLibrary
        )
        retained = next.find((item) => item.id === link.id)
        return next
      },
      playlistJournalDatabase()
    )
    if (!retained) throw Error("Rebind was not retained")
    return retained
  },
  load: async () =>
    validateLinks(
      (await get<LinkedPlaylist[]>(KEY, playlistJournalDatabase())) ?? []
    ),
  save: async (link, expectedRevision) => {
    let retained: LinkedPlaylist | undefined
    await update<LinkedPlaylist[]>(
      KEY,
      (previous) => {
        const next = retainLink(previous ?? [], link, expectedRevision)
        retained = next.find((item) => item.id === link.id)
        return next
      },
      playlistJournalDatabase()
    )
    if (!retained) throw Error("Linked playlist could not be retained")
    return retained
  },
}
