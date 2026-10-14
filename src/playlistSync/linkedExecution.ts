import {
  samePlaylistIdentity,
  type PlaylistAccount,
  type PlaylistSnapshot,
} from "./types"
import {
  applySequenceOperation,
  decideLinkedSync,
  linkedSyncDirection,
  mapLinkedTracks,
  mapImportTracks,
  linkedOwner,
  nextSequenceOperation,
  playlistContent,
  playlistContentHash,
  type LinkedPlaylist,
  type SequenceOperation,
  type SyncSide,
} from "./linked"
import type { LinkedPlaylistRepository } from "./linkedJournal"
import {
  weeklySourceDescription,
  type WeeklyFamily,
  type WeeklyChannel,
} from "./weekly"
export interface LinkedPlaylistAdapter {
  describe?(
    before: PlaylistSnapshot,
    description: string,
    lease: PlaylistAccount
  ): Promise<PlaylistSnapshot>
  preservesDuplicateOccurrences?: boolean
  account(): Promise<PlaylistAccount>
  read(id: string): Promise<PlaylistSnapshot>
  mutate(
    before: PlaylistSnapshot,
    operation: SequenceOperation,
    lease: PlaylistAccount
  ): Promise<PlaylistSnapshot>
}
export interface LinkedSyncServices {
  latestWeekly?(family: WeeklyFamily): Promise<WeeklyChannel>
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
  if (library.readOnly && linkedSyncDirection(link) !== "export")
    return save({
      ...link,
      paused: true,
      state: "conflict",
      message:
        "Smart playlists support Plex → ListenBrainz only. Their membership cannot be changed by sync.",
      lastCheckedAt: now(),
    })
  if (!link.job) {
    let decision = decideLinkedSync(link, library, remote)
    if (link.incomplete) {
      if (
        playlistContent(remote) !==
        playlistContent(link.incomplete.sourceSnapshot)
      )
        decision = {
          status: "conflict",
          reason:
            "The admitted source changed while matching. Review its original and current songs before continuing.",
        }
      else if (
        playlistContent(library) !== playlistContent(link.baseline.library) ||
        (library.description ?? "") !==
          (link.baseline.library.description ?? "")
      )
        decision = {
          status: "conflict",
          reason:
            "The library playlist changed during the incomplete import. Review it before continuing.",
        }
      else if (!remote.items.length && link.weeklySource)
        decision = {
          status: "conflict",
          reason:
            "The weekly source has no verified songs yet. The empty local playlist remains retained for review.",
        }
      else {
        const mapped = mapImportTracks(
          remote,
          link.mappings,
          services.library.preservesDuplicateOccurrences
        )
        link = {
          ...link,
          incomplete: {
            ...link.incomplete,
            matchedCount: mapped.desired.length,
            unsupportedRepeatOccurrenceIds:
              mapped.unsupportedRepeatOccurrenceIds,
            missingOccurrenceIds: mapped.missing.map(
              (index) => remote.items[index].occurrenceId
            ),
          },
        }
        if (!mapped.desired.length && mapped.missing.length)
          return save({
            ...link,
            paused: false,
            pauseReason: undefined,
            state: "ready",
            message: link.incomplete!.matchingDone
              ? "No reliable matches were found. Review the retained source songs before filling the playlist."
              : "Matching source songs in the background; the new playlist is retained.",
          })
        decision = {
          status: "update",
          source: "listenbrainz",
          desired: mapped.desired,
        }
      }
    } else if (
      link.weeklySource &&
      link.weeklySource.lastSyncedEditionId !==
        link.weeklySource.edition.playlistId
    ) {
      if (
        playlistContent(library) !== playlistContent(link.baseline.library) ||
        (library.description ?? "") !==
          (link.baseline.library.description ?? "")
      )
        decision = {
          status: "conflict",
          reason:
            "The library playlist changed before this weekly edition. Review it before replacing songs.",
        }
      else if (
        link.weeklySource.pendingSourceSnapshot &&
        playlistContent(remote) !==
          playlistContent(link.weeklySource.pendingSourceSnapshot)
      )
        decision = {
          status: "conflict",
          reason:
            "The admitted weekly edition changed. Review its current songs before continuing.",
        }
      else if (!remote.items.length)
        decision = {
          status: "conflict",
          reason:
            "This weekly edition has no verified songs. Review the source before changing the library playlist.",
        }
      else {
        const mapped = mapLinkedTracks("listenbrainz", remote, link.mappings)
        decision = mapped.missing.length
          ? {
              status: "matching",
              source: "listenbrainz",
              missing: mapped.missing,
              reason:
                "This weekly edition has unmatched songs. Review every recording before syncing; no songs were dropped.",
            }
          : {
              status: "update",
              source: "listenbrainz",
              desired: mapped.desired,
            }
      }
    }
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
    if (job.descriptionStep) {
      const descriptionStep = job.descriptionStep
      if (
        targetNow.title === descriptionStep.before.title &&
        sameIds(
          targetNow,
          job.desired.map((track) => track.id)
        ) &&
        (targetNow.description ?? "") === descriptionStep.description
      ) {
        await save({
          ...link,
          job: {
            ...job,
            descriptionStep: undefined,
            destinationSnapshot: targetNow,
          },
          descriptionHistory: [
            ...(link.descriptionHistory ?? []),
            {
              ...descriptionStep,
              state: "verified" as const,
              settledAt: now(),
            },
          ].slice(-64),
          state: "ready",
          message: undefined,
        })
        continue
      }
      return save({
        ...link,
        paused: true,
        state: "unknown",
        message:
          "The weekly description update was not confirmed. Read and review the retained operation before retrying.",
      })
    }
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
    const direction = linkedSyncDirection(link)
    if (
      operation &&
      ((direction === "export" && source !== "library") ||
        (direction === "import" && source !== "listenbrainz"))
    ) {
      return save({
        ...link,
        paused: true,
        state: "conflict",
        message:
          "The retained sync job would write against the configured direction. Review partial progress and the link settings before continuing.",
        lastCheckedAt: now(),
      })
    }
    if (
      operation &&
      targetAdapter.preservesDuplicateOccurrences === false &&
      new Set(job.desired.map((track) => track.id)).size !== job.desired.length
    ) {
      return save({
        ...link,
        paused: true,
        state: "conflict",
        message:
          "Plex cannot safely apply repeated songs from this linked playlist. Sync is paused; review the link before continuing.",
        lastCheckedAt: now(),
      })
    }
    if (!operation) {
      if (link.weeklySource && source === "listenbrainz") {
        const partial =
          link.incomplete &&
          (link.incomplete.missingOccurrenceIds.length ||
            !link.incomplete.matchingDone)
        const description =
          weeklySourceDescription(link.weeklySource.edition) +
          (partial
            ? ` Incomplete: ${link.incomplete!.matchedCount} of ${link.incomplete!.total} songs matched.`
            : "")
        if ((targetNow.description ?? "") !== description) {
          if (!targetAdapter.describe)
            return save({
              ...link,
              paused: true,
              state: "conflict",
              message:
                "This connection cannot safely retain the weekly edition description. Review the playlist before continuing.",
            })
          if (
            (targetNow.description ?? "") !==
            (link.baseline.library.description ?? "")
          )
            return save({
              ...link,
              paused: true,
              state: "conflict",
              message:
                "The playlist description changed. Review it before applying the weekly date.",
            })
          const descriptionStep = {
            id: id(),
            weeklyEditionId: link.weeklySource.edition.playlistId,
            before: targetNow,
            description,
            state: "admitting" as const,
          }
          await save({ ...link, job: { ...job, descriptionStep } })
          const retained = (await services.repository.load()).find(
            (item) => item.id === link.id
          )
          if (
            !services.current() ||
            retained?.revision !== link.revision ||
            retained.paused ||
            !retained.enabled
          )
            throw Error("Weekly description settings changed after admission")
          let result: PlaylistSnapshot
          try {
            result = await targetAdapter.describe(targetNow, description, lease)
          } catch {
            return save({
              ...link,
              paused: true,
              state: "unknown",
              message:
                "Weekly description outcome is unknown. Review the retained update before any retry.",
              job: {
                ...link.job!,
                descriptionStep: { ...descriptionStep, state: "unknown" },
              },
            })
          }
          owns()
          if (
            !samePlaylistIdentity(result.account, link.library) ||
            result.title !== targetNow.title ||
            !sameIds(
              result,
              job.desired.map((track) => track.id)
            ) ||
            result.description !== description
          )
            return save({
              ...link,
              paused: true,
              state: "unknown",
              message:
                "Weekly description proof did not match. Review the destination before continuing.",
            })
          await save({
            ...link,
            job: {
              ...link.job!,
              descriptionStep: undefined,
              destinationSnapshot: result,
            },
            descriptionHistory: [
              ...(link.descriptionHistory ?? []),
              {
                ...descriptionStep,
                state: "verified" as const,
                settledAt: now(),
              },
            ].slice(-64),
            state: "ready",
            message: undefined,
          })
          continue
        }
      }
      const finalLibrary = destination === "library" ? targetNow : sourceNow,
        finalRemote = destination === "listenbrainz" ? targetNow : sourceNow
      const partial =
        !!link.incomplete &&
        (link.incomplete.missingOccurrenceIds.length > 0 ||
          !link.incomplete.matchingDone)
      return save({
        ...link,
        baseline: { library: finalLibrary, listenbrainz: finalRemote },
        baselineHashes: {
          library: await playlistContentHash(finalLibrary),
          listenbrainz: await playlistContentHash(finalRemote),
        },
        job: undefined,
        ...(link.weeklySource && !partial
          ? {
              weeklySource: {
                ...link.weeklySource,
                lastSyncedEditionId: link.weeklySource.edition.playlistId,
                pendingSourceSnapshot: undefined,
              },
            }
          : {}),
        incomplete: partial ? link.incomplete : undefined,
        paused: false,
        pauseReason: undefined,
        state: "ready",
        message: partial
          ? `${link.incomplete!.matchedCount} of ${link.incomplete!.total} songs matched. ${link.incomplete!.matchingDone ? "Review unmatched songs; every original occurrence is retained." : "Background matching continues."}`
          : undefined,
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
          ...(link.weeklySource
            ? { weeklyEditionId: link.weeklySource.edition.playlistId }
            : {}),
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
  if (link.job?.descriptionStep)
    return reconcileLinkedDescriptionStep(link, services, allowReviewedRetry)
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
  if (link.job?.descriptionStep)
    return reconcileLinkedDescriptionStep(link, services, false, reviewed)
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
/** Description recovery is read-only; a failed PUT is never automatically replayed. */
async function reconcileLinkedDescriptionStep(
  link: LinkedPlaylist,
  services: LinkedSyncServices,
  allowReviewedRetry: boolean,
  reviewed?: PlaylistSnapshot
): Promise<LinkedPlaylist> {
  const job = link.job,
    step = job?.descriptionStep
  if (!job || !step || !services.current())
    throw Error("No retained weekly description to reconcile")
  const [account, actual] = await Promise.all([
    services.library.account(),
    services.library.read(step.before.id),
  ])
  if (
    !services.current() ||
    !samePlaylistIdentity(account, link.library) ||
    !samePlaylistIdentity(actual.account, link.library) ||
    actual.id !== step.before.id
  )
    throw Error("Weekly destination account changed")
  const same = playlistContent(actual) === playlistContent(step.before)
  const applied = same && (actual.description ?? "") === step.description
  const before =
    same && (actual.description ?? "") === (step.before.description ?? "")
  if (reviewed) {
    if (
      !samePlaylistIdentity(reviewed.account, actual.account) ||
      playlistContent(reviewed) !== playlistContent(actual) ||
      (reviewed.description ?? "") !== (actual.description ?? "")
    )
      throw Error("Reviewed description changed. Read again")
  } else if (!applied && !(before && allowReviewedRetry))
    throw Error(
      before
        ? "No description update was confirmed. Explicitly review before retrying."
        : "Destination differs from the retained description proof. Review it before any write."
    )
  const next: LinkedPlaylist = {
    ...link,
    paused: true,
    state: "conflict",
    message: reviewed
      ? "The uncertain description intent was retained after reviewing the current playlist. Review the weekly source before resuming."
      : applied
        ? "Weekly description verified. Review remaining progress before resuming."
        : "Description was reviewed as not applied. Review before a fresh request.",
    job: reviewed
      ? undefined
      : { ...job, descriptionStep: undefined, destinationSnapshot: actual },
    descriptionHistory: [
      ...(link.descriptionHistory ?? []),
      {
        ...step,
        state: reviewed
          ? ("reviewed-current" as const)
          : applied
            ? ("verified" as const)
            : ("reviewed-not-applied" as const),
        settledAt: (services.now ?? Date.now)(),
      },
    ].slice(-64),
  }
  const saved = await services.repository.save(next, link.revision)
  if (!services.current()) throw Error("Weekly recovery owner changed")
  return saved
}
