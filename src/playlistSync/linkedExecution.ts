import {
  samePlaylistIdentity,
  type PlaylistAccount,
  type PlaylistSnapshot,
} from "./types"
import {
  applySequenceOperation,
  decideLinkedSync,
  linkedOwner,
  nextSequenceOperation,
  playlistContent,
  playlistContentHash,
  type LinkedPlaylist,
  type SequenceOperation,
  type SyncSide,
} from "./linked"
import type { LinkedPlaylistRepository } from "./linkedJournal"
export interface LinkedPlaylistAdapter {
  account(): Promise<PlaylistAccount>
  read(id: string): Promise<PlaylistSnapshot>
  mutate(
    before: PlaylistSnapshot,
    operation: SequenceOperation,
    lease: PlaylistAccount
  ): Promise<PlaylistSnapshot>
}
export interface LinkedSyncServices {
  library: LinkedPlaylistAdapter
  listenbrainz: LinkedPlaylistAdapter
  repository: LinkedPlaylistRepository
  current(): boolean
  now?(): number
  id?(): string
}
const ids = (snapshot: PlaylistSnapshot) =>
  snapshot.items.map((item) => item.track.id)
const sameIds = (snapshot: PlaylistSnapshot, expected: readonly string[]) =>
  JSON.stringify(ids(snapshot)) === JSON.stringify(expected)
/** Every admitted verb has a durable before/after proof. No automatic mutation retry. */
export async function checkLinkedPlaylist(
  initial: LinkedPlaylist,
  services: LinkedSyncServices,
  maxSteps = 20
): Promise<LinkedPlaylist> {
  let link = structuredClone(initial)
  const now = services.now ?? Date.now,
    id = services.id ?? (() => crypto.randomUUID())
  const owns = () => {
    if (!services.current()) throw Error("Playlist sync session changed")
  }
  const save = async (next: LinkedPlaylist) => {
    owns()
    link = await services.repository.save(next, link.revision)
    owns()
    return link
  }
  if (!link.enabled || link.paused) return link
  owns()
  const [library, remote] = await Promise.all([
    services.library.read(link.libraryPlaylistId),
    services.listenbrainz.read(link.listenbrainzPlaylistId),
  ])
  owns()
  if (!linkedOwner(link, library, remote))
    return save({
      ...link,
      paused: true,
      state: "conflict",
      message:
        "Linked account changed. Reconnect the original account before reviewing.",
      lastCheckedAt: now(),
    })
  if (!link.job) {
    const decision = decideLinkedSync(link, library, remote)
    if (decision.status === "idle")
      return save({
        ...link,
        lastCheckedAt: now(),
        message: undefined,
        state: "ready",
      })
    if (decision.status !== "update")
      return save({
        ...link,
        paused: true,
        state: "conflict",
        message:
          decision.reason ?? "Review this linked playlist before continuing.",
        lastCheckedAt: now(),
      })
    const sourceSnapshot = decision.source === "library" ? library : remote,
      destinationSnapshot = decision.source === "library" ? remote : library
    await save({
      ...link,
      job: {
        id: id(),
        source: decision.source,
        sourceSnapshot,
        destinationSnapshot,
        desired: decision.desired,
        completedSteps: 0,
      },
      state: "ready",
      lastCheckedAt: now(),
    })
  }
  const source: SyncSide = link.job!.source,
    destination = source === "library" ? "listenbrainz" : "library",
    sourceAdapter = services[source],
    targetAdapter = services[destination]
  for (let count = 0; count < maxSteps; count++) {
    owns()
    const persisted = (await services.repository.load()).find(
      (item) => item.id === link.id
    )
    if (
      !persisted ||
      persisted.revision !== link.revision ||
      !persisted.enabled ||
      persisted.paused
    )
      throw Error("Playlist sync settings changed")
    const [sourceNow, targetNow, lease] = await Promise.all([
      sourceAdapter.read(link.job!.sourceSnapshot.id),
      targetAdapter.read(link.job!.destinationSnapshot.id),
      targetAdapter.account(),
    ])
    owns()
    if (
      !samePlaylistIdentity(lease, link[destination]) ||
      playlistContent(sourceNow) !== playlistContent(link.job!.sourceSnapshot)
    )
      return save({
        ...link,
        paused: true,
        state: "conflict",
        message:
          "Source or destination account changed during sync. Review partial progress.",
      })
    const job = link.job!,
      step = job.step
    if (step) {
      // An unknown/admitted operation is reconciled by reads only, never resent.
      if (
        targetNow.title === step.before.title &&
        sameIds(targetNow, step.afterIds)
      ) {
        await save({
          ...link,
          job: {
            ...job,
            step: undefined,
            destinationSnapshot: targetNow,
            completedSteps: job.completedSteps + 1,
          },
          history: [
            ...(link.history ?? []),
            { ...step, state: "verified" as const, settledAt: now() },
          ].slice(-64),
          state: "ready",
          message: undefined,
        })
      } else
        return save({
          ...link,
          paused: true,
          state: "unknown",
          message: sameIds(targetNow, ids(step.before))
            ? "Previous update was not confirmed. Review before retrying this occurrence."
            : "Destination changed or update is partial. Review before continuing.",
        })
      continue
    }
    if (playlistContent(targetNow) !== playlistContent(job.destinationSnapshot))
      return save({
        ...link,
        paused: true,
        state: "conflict",
        message: "Destination changed during sync. Review both versions.",
      })
    const operation = nextSequenceOperation(
      ids(targetNow),
      job.desired.map((track) => track.id)
    )
    if (!operation) {
      const finalLibrary = destination === "library" ? targetNow : sourceNow,
        finalRemote = destination === "listenbrainz" ? targetNow : sourceNow
      return save({
        ...link,
        baseline: { library: finalLibrary, listenbrainz: finalRemote },
        baselineHashes: {
          library: await playlistContentHash(finalLibrary),
          listenbrainz: await playlistContentHash(finalRemote),
        },
        job: undefined,
        state: "ready",
        message: undefined,
        lastSyncAt: now(),
        lastCheckedAt: now(),
      })
    }
    await save({
      ...link,
      job: {
        ...job,
        step: {
          id: id(),
          before: targetNow,
          afterIds: applySequenceOperation(ids(targetNow), operation),
          operation,
          state: "admitting",
        },
      },
    })
    // Pausing/settings changes after admission prevents the next verb; an in-flight
    // verb may finish and remains recoverable from its retained proof.
    owns()
    const latest = (await services.repository.load()).find(
      (item) => item.id === link.id
    )
    if (
      !latest ||
      latest.revision !== link.revision ||
      !latest.enabled ||
      latest.paused
    )
      throw Error(
        "Playlist sync paused after admission; review the retained operation"
      )
    let result: PlaylistSnapshot
    try {
      result = await targetAdapter.mutate(targetNow, operation, lease)
    } catch {
      return save({
        ...link,
        paused: true,
        state: "unknown",
        message:
          "Update outcome is unknown. Read and reconcile before any further write.",
        job: { ...link.job!, step: { ...link.job!.step!, state: "unknown" } },
      })
    }
    owns()
    if (
      result.title !== targetNow.title ||
      !sameIds(result, link.job!.step!.afterIds)
    )
      return save({
        ...link,
        paused: true,
        state: "unknown",
        message:
          "Destination response does not match the intended occurrence update. Review before continuing.",
      })
    await save({
      ...link,
      job: {
        ...link.job!,
        step: undefined,
        destinationSnapshot: result,
        completedSteps: link.job!.completedSteps + 1,
      },
      history: [
        ...(link.history ?? []),
        { ...link.job!.step!, state: "verified" as const, settledAt: now() },
      ].slice(-64),
      state: "ready",
      message: undefined,
    })
  }
  return link
}

/** Explicit read-only reconciliation. A before-match needs fresh human approval to retry. */
export async function reconcileLinkedStep(
  link: LinkedPlaylist,
  services: LinkedSyncServices,
  allowReviewedRetry = false
): Promise<LinkedPlaylist> {
  const job = link.job,
    step = job?.step
  if (!job || !step) throw Error("No retained operation to reconcile")
  if (!services.current()) throw Error("Playlist sync session changed")
  const destination = job.source === "library" ? "listenbrainz" : "library",
    target = services[destination]
  const [account, actual] = await Promise.all([
    target.account(),
    target.read(step.before.id),
  ])
  if (
    !services.current() ||
    !samePlaylistIdentity(account, link[destination]) ||
    !samePlaylistIdentity(actual.account, link[destination])
  )
    throw Error("Linked destination account changed")
  const applied =
      actual.title === step.before.title && sameIds(actual, step.afterIds),
    before = playlistContent(actual) === playlistContent(step.before)
  if (!applied && !(before && allowReviewedRetry))
    throw Error(
      before
        ? "No update was confirmed. Explicitly review before retrying."
        : "Destination differs from both retained versions. Resolve the conflict before any write."
    )
  const next: LinkedPlaylist = {
    ...link,
    paused: true,
    state: "conflict",
    message: applied
      ? "Previous occurrence update verified. Review remaining progress before resuming."
      : "Previous occurrence was reviewed as not applied. Review the remaining plan before resuming.",
    job: {
      ...job,
      step: undefined,
      destinationSnapshot: actual,
      completedSteps: job.completedSteps + (applied ? 1 : 0),
    },
    history: [
      ...(link.history ?? []),
      {
        ...step,
        state: applied
          ? ("verified" as const)
          : ("reviewed-not-applied" as const),
        settledAt: (services.now ?? Date.now)(),
      },
    ].slice(-64),
  }
  const saved = await services.repository.save(next, link.revision)
  if (!services.current()) throw Error("Playlist sync session changed")
  return saved
}

/** A diverged destination can only be archived after reviewing its current snapshot.
 * This records the uncertain old intent; it never retries or resumes mutations. */
export async function archiveReviewedLinkedStep(
  link: LinkedPlaylist,
  services: LinkedSyncServices,
  reviewed: PlaylistSnapshot
): Promise<LinkedPlaylist> {
  const job = link.job,
    step = job?.step
  if (!job || !step || !services.current())
    throw Error("Recovery ownership changed")
  const destination = job.source === "library" ? "listenbrainz" : "library"
  const [account, actual] = await Promise.all([
    services[destination].account(),
    services[destination].read(step.before.id),
  ])
  if (
    !services.current() ||
    !samePlaylistIdentity(account, link[destination]) ||
    !samePlaylistIdentity(reviewed.account, account) ||
    playlistContent(actual) !== playlistContent(reviewed)
  )
    throw Error("Reviewed destination changed. Read again.")
  const next: LinkedPlaylist = {
    ...link,
    paused: true,
    state: "conflict",
    message:
      "Uncertain prior update retained after manual current-state review. Preview both versions before enabling again.",
    job: { ...job, step: undefined, destinationSnapshot: actual },
    history: [
      ...(link.history ?? []),
      {
        ...step,
        state: "reviewed-current" as const,
        settledAt: (services.now ?? Date.now)(),
      },
    ].slice(-64),
  }
  const saved = await services.repository.save(next, link.revision)
  if (!services.current()) throw Error("Recovery ownership changed")
  return saved
}
