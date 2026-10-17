import { createVerifiedPlaylistRefresh } from "./verifiedPlaylistRefresh"
import type { MusicProvider } from "../providers/types"
import { playlistCandidateScore, matchTrack, recordingMbid } from "./matching"
import { providerPlaylistAccount } from "./provider"
import {
  candidateQueryKey,
  retrievePlaylistCandidates,
} from "./candidateRetrieval"
import { samePlaylistIdentity, type PlaylistTrack } from "./types"
import {
  mapImportTracks,
  isCompletedPartialMatch,
  type LinkedPlaylist,
  type LinkedTrackMapping,
} from "./linked"
import type { LinkedPlaylistRepository } from "./linkedJournal"
import { linkedSyncServices } from "./linkedServices"
import { checkLinkedPlaylist, type LinkedSyncServices } from "./linkedExecution"
/** Batches bound concurrency/memory, not the number of selected songs that receive a lookup. */
export async function matchInitialSync(
  id: string,
  provider: MusicProvider,
  repository: LinkedPlaylistRepository,
  current: () => boolean,
  servicesFor: (link: LinkedPlaylist) => Promise<LinkedSyncServices> = (link) =>
    linkedSyncServices(provider, link, current)
): Promise<void> {
  const notifyVerified = createVerifiedPlaylistRefresh(provider, current)
  const owns = () => {
    if (!current()) throw Error("Initial sync owner changed")
  }
  const load = async () => {
    owns()
    const link = (await repository.load()).find((item) => item.id === id)
    owns()
    if (
      !link ||
      !samePlaylistIdentity(link.library, providerPlaylistAccount(provider))
    )
      throw Error("Initial sync belongs to another library")
    return link
  }
  let link = await load()
  if (
    !link.enabled ||
    link.paused ||
    !link.incomplete ||
    isCompletedPartialMatch(link)
  )
    return
  const source = link.incomplete.sourceSnapshot
  const preservesDuplicates = (await servicesFor(link)).library
    .preservesDuplicateOccurrences
  owns()
  // New safety rules must not inherit an older automatic decision as verified identity.
  // Retained jobs remain immutable until their admitted operations are reconciled.
  if (!link.job) {
    const mappings = revalidateAutomaticMappings(link)
    if (mappings.length !== link.mappings.length) {
      owns()
      const mapped = mapImportTracks(source, mappings, preservesDuplicates)
      link = await repository.save(
        {
          ...link,
          mappings,
          incomplete: {
            ...link.incomplete!,
            matchingCursor: 0,
            matchingDone: false,
            matchedCount: mapped.desired.length,
            unsupportedRepeatOccurrenceIds:
              mapped.unsupportedRepeatOccurrenceIds,
            missingOccurrenceIds: mapped.missing.map(
              (index) => source.items[index].occurrenceId
            ),
          },
        },
        link.revision
      )
      owns()
    }
  }
  const queries = [
    ...new Map(
      source.items.map((item) => [candidateQueryKey(item.track), item.track])
    ).values(),
  ]
  async function fill() {
    let chunks = 0
    do {
      owns()
      if (link.paused || !link.enabled) return
      const services = await servicesFor(link)
      owns()
      services.repository = repository
      const mutate = services.library.mutate
      services.library.mutate = async (...args) => {
        const result = await mutate(...args)
        if (current()) notifyVerified(result)
        return result
      }
      const describe = services.library.describe
      if (describe)
        services.library.describe = async (...args) => {
          const result = await describe(...args)
          if (current()) notifyVerified(result)
          return result
        }
      link = await checkLinkedPlaylist(link, services, 20)
      owns()
      if (++chunks > 200) throw Error("Initial sync progress needs review")
    } while (link.job && !link.paused)
  }
  if (link.job) {
    await fill()
    if (link.paused || !link.incomplete) return
  }
  while (link.incomplete && !link.incomplete.matchingDone && !link.paused) {
    owns()
    if (!provider.capabilities.search) {
      link = await repository.save(
        {
          ...link,
          paused: true,
          state: "conflict",
          incomplete: { ...link.incomplete, matchingDone: true },
          message:
            "This connection cannot search for automatic matches. Review every retained source song manually.",
        },
        link.revision
      )
      return
    }
    const start = link.incomplete.matchingCursor,
      batch = queries.slice(start, start + 30)
    let next = 0
    const results = new Map<string, PlaylistTrack[]>()
    const issues = new Map<string, "truncated" | "unavailable">()
    await Promise.all(
      Array.from({ length: Math.min(3, batch.length) }, async () => {
        while (next < batch.length) {
          owns()
          const track = batch[next++],
            key = candidateQueryKey(track)
          try {
            const candidates = await retrievePlaylistCandidates(
              provider,
              track,
              current,
              (reason) => issues.set(key, reason)
            )
            results.set(key, candidates)
          } catch {
            owns()
            issues.set(key, "unavailable")
          }
        }
      })
    )
    owns()
    const fresh = await load()
    if (fresh.revision !== link.revision)
      throw Error("Matching settings changed")
    const mappings: LinkedTrackMapping[] = [...link.mappings]
    for (const item of source.items) {
      const mbid = recordingMbid(item.track.recordingMbid)
      if (
        !mbid ||
        mappings.some(
          (mapping) =>
            mapping.recordingMbid === mbid && !mapping.sourceOccurrenceId
        )
      )
        continue
      const candidates = results.get(candidateQueryKey(item.track))
      if (!candidates) continue
      const match = matchTrack(item.track, candidates)
      if (match.status === "matched")
        mappings.push({
          libraryTrack: match.track,
          recordingMbid: mbid,
          verifiedBy: match.by === "mbid" ? "provider-mbid" : "metadata",
          score: match.score,
        })
    }
    const mapped = mapImportTracks(source, mappings, preservesDuplicates)
    const cursor = start + batch.length,
      done = cursor >= queries.length
    link = await repository.save(
      {
        ...link,
        mappings,
        incomplete: {
          ...link.incomplete!,
          matchingCursor: cursor,
          matchingDone: done,
          lookupLimits: [
            ...(link.incomplete!.lookupLimits ?? []).filter(
              (issue) =>
                !source.items.some(
                  (item) =>
                    item.track.id === issue.sourceTrackId &&
                    batch.some(
                      (track) =>
                        candidateQueryKey(track) ===
                        candidateQueryKey(item.track)
                    )
                )
            ),
            ...[
              ...new Map(
                source.items
                  .filter((item) => issues.has(candidateQueryKey(item.track)))
                  .map((item) => [
                    item.track.id,
                    {
                      sourceTrackId: item.track.id,
                      reason: issues.get(candidateQueryKey(item.track))!,
                    },
                  ])
              ).values(),
            ],
          ],
          matchedCount: mapped.desired.length,
          unsupportedRepeatOccurrenceIds: mapped.unsupportedRepeatOccurrenceIds,
          missingOccurrenceIds: mapped.missing.map(
            (index) => source.items[index].occurrenceId
          ),
        },
        state: "ready",
        paused: false,
        message:
          "Matching the selected playlist in bounded background batches.",
      },
      link.revision
    )
    owns()
    await fill()
    if (!batch.length) return
  }
  if (
    link.incomplete &&
    link.incomplete.matchingDone &&
    !link.paused &&
    !isCompletedPartialMatch(link)
  )
    await fill()
}

/** Explicit re-match admission recognizes an engine result, never an ownership/content conflict. */
export function canRematchIncomplete(link: LinkedPlaylist): boolean {
  return link.enabled && isCompletedPartialMatch(link)
}
/** Lookup retry cannot acknowledge an unknown write or override a content conflict. */
export function resumeInitialMatching(link: LinkedPlaylist): LinkedPlaylist {
  const completed = canRematchIncomplete(link)
  if (
    !link.enabled ||
    !link.incomplete ||
    (!completed &&
      (link.incomplete.matchingDone ||
        !["ready", "error"].includes(link.state))) ||
    link.pauseReason === "manual" ||
    link.job?.step ||
    link.job?.descriptionStep
  )
    throw Error("Review retained playlist changes before retrying matching")
  return {
    ...link,
    paused: false,
    pauseReason: undefined,
    state: "ready",
    incomplete: completed
      ? { ...link.incomplete, matchingCursor: 0, matchingDone: false }
      : link.incomplete,
    message:
      "Retrying the retained source lookups in bounded background batches.",
  }
}

/** Only automatic label-based mappings are reconsidered; explicit reviews and verified IDs survive. */
export function revalidateAutomaticMappings(
  link: LinkedPlaylist
): LinkedTrackMapping[] {
  if (link.job || !link.incomplete) return link.mappings
  return link.mappings.filter((mapping) => {
    if (mapping.verifiedBy !== "metadata") return true
    const occurrences = link.incomplete!.sourceSnapshot.items.filter(
      (item) =>
        recordingMbid(item.track.recordingMbid) === mapping.recordingMbid &&
        (!mapping.sourceOccurrenceId ||
          mapping.sourceOccurrenceId === item.occurrenceId)
    )
    return (
      occurrences.length > 0 &&
      occurrences.every(
        (item) =>
          playlistCandidateScore(item.track, {
            ...mapping.libraryTrack,
            recordingMbid: null,
          }) > 0.95
      )
    )
  })
}
