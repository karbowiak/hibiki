import { get, update } from "idb-keyval"
import { playlistJournalDatabase } from "./journal"
import { samePlaylistIdentity } from "./types"
import { validateSnapshot } from "./planner"
import {
  linkedSyncDirection,
  linkedAutomaticSync,
  mapLinkedTracks,
  canAdvancePartialWeekly,
  type LinkedPlaylist,
} from "./linked"
import { playlistContent, playlistContentHash } from "./linked"
import {
  validWeeklyEdition,
  newerWeeklyEdition,
  retainWeeklyHistory,
  type WeeklyEdition,
} from "./weekly"
import type { PlaylistSnapshot } from "./types"
const KEY = "linked-playlists-v1"
export interface LinkedPlaylistRepository {
  bindWeeklyEdition?(
    link: LinkedPlaylist,
    expectedRevision: number,
    edition: WeeklyEdition,
    source: PlaylistSnapshot,
    library: PlaylistSnapshot
  ): Promise<LinkedPlaylist>
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
      (link.pauseReason !== undefined &&
        !["unmatched", "manual"].includes(link.pauseReason)) ||
      (link.direction !== undefined &&
        !["export", "import", "bidirectional"].includes(link.direction)) ||
      (link.automatic !== undefined && typeof link.automatic !== "boolean") ||
      link.mappings.length > 1000
    )
      throw Error("Invalid linked playlist settings")
    ids.add(link.id)
    validateSnapshot(link.baseline.library)
    validateSnapshot(link.baseline.listenbrainz)
    if (link.incomplete) {
      const partial = link.incomplete
      validateSnapshot(partial.sourceSnapshot)
      const occurrences = new Set(
        partial.sourceSnapshot.items.map((item) => item.occurrenceId)
      )
      if (
        linkedSyncDirection(link) !== "import" ||
        partial.sourceSnapshot.id !== link.listenbrainzPlaylistId ||
        !samePlaylistIdentity(
          partial.sourceSnapshot.account,
          link.listenbrainz
        ) ||
        partial.total !== partial.sourceSnapshot.items.length ||
        !Number.isSafeInteger(partial.matchingCursor) ||
        partial.matchingCursor < 0 ||
        partial.matchingCursor > partial.total ||
        !Number.isSafeInteger(partial.matchedCount) ||
        partial.matchedCount < 0 ||
        partial.matchedCount > partial.total ||
        typeof partial.matchingDone !== "boolean" ||
        (partial.unsupportedRepeatOccurrenceIds ?? []).some(
          (id) => !partial.missingOccurrenceIds.includes(id)
        ) ||
        partial.missingOccurrenceIds.some((id) => !occurrences.has(id)) ||
        new Set(partial.missingOccurrenceIds).size !==
          partial.missingOccurrenceIds.length
      )
        throw Error("Invalid incomplete sync progress")
    }
    if (link.weeklySource) {
      const weekly = link.weeklySource
      if (
        linkedSyncDirection(link) !== "import" ||
        weekly.recipient !== link.listenbrainz.user ||
        weekly.family !== weekly.edition.family ||
        weekly.edition.playlistId !== link.listenbrainzPlaylistId ||
        !validWeeklyEdition(weekly.edition, link.listenbrainz) ||
        (weekly.previousEditions?.length ?? 0) > 32 ||
        (weekly.lastSyncedEditionId !== undefined &&
          !/^[0-9a-f-]{36}$/i.test(weekly.lastSyncedEditionId))
      )
        throw Error("Invalid weekly source binding")
      for (const receipt of weekly.previousEditions ?? []) {
        if (receipt.missingOccurrences) {
          if (
            receipt.missingOccurrences.length > 1000 ||
            !Number.isSafeInteger(receipt.total) ||
            receipt.total! < receipt.missingOccurrences.length ||
            receipt.total! > 1000 ||
            !Number.isSafeInteger(receipt.matchedCount) ||
            receipt.matchedCount! < 0 ||
            receipt.matchedCount! + receipt.missingOccurrences.length !==
              receipt.total
          )
            throw Error("Invalid archived weekly missing songs")
          validateSnapshot({
            id: receipt.edition.playlistId,
            account: link.listenbrainz,
            title: "Archived weekly source",
            items: receipt.missingOccurrences,
          })
        }
        if (
          !validWeeklyEdition(receipt.edition, link.listenbrainz) ||
          receipt.edition.family !== weekly.family ||
          !/^[0-9a-f]{64}$/.test(receipt.sourceHash)
        )
          throw Error("Invalid weekly source history")
      }
      if (weekly.pendingSourceSnapshot) {
        validateSnapshot(weekly.pendingSourceSnapshot)
        if (
          weekly.pendingSourceSnapshot.id !== weekly.edition.playlistId ||
          !samePlaylistIdentity(
            weekly.pendingSourceSnapshot.account,
            link.listenbrainz
          )
        )
          throw Error("Invalid admitted weekly source")
      }
    }
    if (link.job) {
      validateSnapshot(link.job.sourceSnapshot)
      validateSnapshot(link.job.destinationSnapshot)
      if (link.job.descriptionStep) {
        const step = link.job.descriptionStep
        validateSnapshot(step.before)
        if (
          !link.weeklySource ||
          step.weeklyEditionId !== link.weeklySource.edition.playlistId ||
          step.description.length > 5000 ||
          step.before.id !== link.libraryPlaylistId
        )
          throw Error("Invalid weekly description recovery state")
      }
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
    (existing?.job?.step || existing?.job?.descriptionStep) &&
    linkedSyncDirection(existing) !== linkedSyncDirection(link)
  )
    throw Error(
      "Review the unresolved sync operation before changing direction"
    )
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
    existing &&
    JSON.stringify(existing.weeklySource?.edition) !==
      JSON.stringify(link.weeklySource?.edition) &&
    !(
      !existing.weeklySource &&
      !existing.job &&
      link.weeklySource?.edition.playlistId === existing.listenbrainzPlaylistId
    )
  )
    throw Error(
      "Review and bind the verified weekly edition before changing its source"
    )
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
  if (
    link.weeklySource &&
    previous.some(
      (item) =>
        item.id !== link.id &&
        item.weeklySource?.family === link.weeklySource?.family &&
        samePlaylistIdentity(item.library, link.library) &&
        samePlaylistIdentity(item.listenbrainz, link.listenbrainz)
    )
  )
    throw Error("This weekly channel already has a library playlist")
  const next = structuredClone({
    ...link,
    direction: linkedSyncDirection(link),
    automatic: linkedAutomaticSync(link),
    revision: (existing?.revision ?? -1) + 1,
  })
  return validateLinks([
    ...previous.filter((item) => item.id !== link.id),
    next,
  ])
}
/** The only remote-ID replacement path; unresolved earlier editions cannot be rebound. */
export function retainWeeklyEdition(
  previous: LinkedPlaylist[],
  id: string,
  revision: number,
  edition: WeeklyEdition,
  source: PlaylistSnapshot,
  library: PlaylistSnapshot,
  previousSourceHash: string
): LinkedPlaylist[] {
  validateLinks(previous)
  validateSnapshot(source)
  validateSnapshot(library)
  const current = previous.find((link) => link.id === id),
    weekly = current?.weeklySource
  if (
    !current ||
    current.revision !== revision ||
    !weekly ||
    current.job ||
    (current.incomplete && !canAdvancePartialWeekly(current)) ||
    (weekly.lastSyncedEditionId !== weekly.edition.playlistId &&
      !canAdvancePartialWeekly(current)) ||
    (current.paused && !canAdvancePartialWeekly(current)) ||
    !current.enabled ||
    !/^[0-9a-f]{64}$/.test(previousSourceHash) ||
    linkedSyncDirection(current) !== "import" ||
    !validWeeklyEdition(edition, current.listenbrainz) ||
    edition.family !== weekly.family ||
    source.id !== edition.playlistId ||
    !samePlaylistIdentity(source.account, current.listenbrainz) ||
    library.id !== current.libraryPlaylistId ||
    !samePlaylistIdentity(library.account, current.library) ||
    playlistContent(library) !== playlistContent(current.baseline.library) ||
    (library.description ?? "") !== (current.baseline.library.description ?? "")
  )
    throw Error(
      "Review current weekly progress and library changes before rebinding"
    )
  if (edition.playlistId === weekly.edition.playlistId) return previous
  if (!newerWeeklyEdition(edition, weekly.edition))
    throw Error("Weekly edition is not newer than the retained source")
  if (
    previous.some(
      (link) =>
        link.id !== id &&
        samePlaylistIdentity(link.listenbrainz, current.listenbrainz) &&
        link.listenbrainzPlaylistId === edition.playlistId
    )
  )
    throw Error("This weekly edition is already linked")
  const mappings = current.mappings.filter(
    (mapping) =>
      !mapping.sourceOccurrenceId &&
      source.items.some(
        (item) => item.track.recordingMbid === mapping.recordingMbid
      )
  )
  const mapped = mapLinkedTracks("listenbrainz", source, mappings)
  const next: LinkedPlaylist = {
    ...current,
    paused: false,
    pauseReason: undefined,
    incomplete: {
      sourceSnapshot: structuredClone(source),
      missingOccurrenceIds: mapped.missing.map(
        (index) => source.items[index].occurrenceId
      ),
      matchedCount: mapped.desired.length,
      total: source.items.length,
      matchingCursor: 0,
      matchingDone: !mapped.missing.length,
    },
    revision: current.revision + 1,
    listenbrainzPlaylistId: edition.playlistId,
    mappings,
    weeklySource: {
      ...weekly,
      edition: structuredClone(edition),
      pendingSourceSnapshot: structuredClone(source),
      previousEditions: retainWeeklyHistory([
        ...(weekly.previousEditions ?? []),
        {
          edition: weekly.edition,
          sourceHash: previousSourceHash,
          ...(current.incomplete
            ? {
                finishedAt: Date.now(),
                total: current.incomplete.total,
                matchedCount: current.incomplete.matchedCount,
                missingOccurrences: structuredClone(
                  current.incomplete.sourceSnapshot.items.filter((item) =>
                    current.incomplete!.missingOccurrenceIds.includes(
                      item.occurrenceId
                    )
                  )
                ),
              }
            : {}),
          syncedAt:
            weekly.lastSyncedEditionId === weekly.edition.playlistId
              ? current.lastSyncAt
              : undefined,
        },
      ]),
    },
    state: "ready",
    message: undefined,
  }
  return validateLinks(
    previous.map((link) => (link.id === id ? structuredClone(next) : link))
  )
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
    current.job?.step ||
    current.job?.descriptionStep
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
  bindWeeklyEdition: async (
    link,
    expectedRevision,
    edition,
    source,
    library
  ) => {
    let retained: LinkedPlaylist | undefined
    const current = (await linkedPlaylistRepository.load()).find(
      (item) => item.id === link.id
    )
    if (!current || current.revision !== expectedRevision)
      throw Error("Weekly settings changed before source admission")
    const hash = await playlistContentHash(
      current.weeklySource?.pendingSourceSnapshot ??
        current.baseline.listenbrainz
    )
    await update<LinkedPlaylist[]>(
      KEY,
      (previous) => {
        const next = retainWeeklyEdition(
          previous ?? [],
          link.id,
          expectedRevision,
          edition,
          source,
          library,
          hash
        )
        retained = next.find((item) => item.id === link.id)
        return next
      },
      playlistJournalDatabase()
    )
    if (!retained) throw Error("Weekly edition was not retained")
    return retained
  },
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
