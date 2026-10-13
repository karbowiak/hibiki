import {
  snapshotRevision,
  resolvedTracks,
  deepFreeze,
  playlistCopyBlockReason,
} from "./planner"
import {
  sameAccount,
  samePlaylistIdentity,
  type PlaylistAdapter,
  type PlaylistAttempt,
  type PlaylistAttemptJournal,
  type PlaylistPlan,
} from "./types"
export class PlaylistCopyError extends Error {
  constructor(
    message: string,
    readonly attempt: PlaylistAttempt
  ) {
    super(message)
  }
}
/** A reviewed plan is single-use. Unknown outcomes require reconciliation rather than a duplicate create. */
export class PlaylistCopyApproval {
  private used = false
  readonly plan: PlaylistPlan
  constructor(plan: PlaylistPlan) {
    this.plan = deepFreeze(structuredClone(plan))
  }
  claim() {
    if (this.used)
      throw Error(
        "This preview was already submitted. Reconcile or create a new preview."
      )
    this.used = true
  }
}
export async function executePlaylistCopy(
  approval: PlaylistCopyApproval,
  source: PlaylistAdapter,
  target: PlaylistAdapter,
  journal: PlaylistAttemptJournal,
  isCurrent: () => boolean
): Promise<PlaylistAttempt> {
  const plan = approval.plan,
    tracks = resolvedTracks(plan)
  if (!target.capabilities.createCopy)
    throw Error("Destination does not support creating playlists")
  const blocked = playlistCopyBlockReason(plan, target.capabilities)
  if (blocked) throw Error(blocked)
  const [sourceAccount, targetAccount, currentSource] = await Promise.all([
    source.account(),
    target.account(),
    source.read(plan.source.id),
  ])
  if (
    !isCurrent() ||
    !sameAccount(sourceAccount, plan.source.account) ||
    !sameAccount(targetAccount, plan.target)
  )
    throw Error("Playlist account changed. Preview again.")
  if (
    !sameAccount(currentSource.account, plan.source.account) ||
    snapshotRevision(currentSource) !== plan.sourceRevision
  )
    throw Error("Source playlist changed. Preview again.")
  // Deliberately create a copy: no destination is overwritten, and either-side edits cannot be merged implicitly.
  approval.claim()
  let attempt: PlaylistAttempt = {
    id: crypto.randomUUID(),
    account: plan.target,
    sourceAccount: plan.source.account,
    sourcePlaylistId: plan.source.id,
    title: plan.title,
    createdAt: Date.now(),
    state: "admitting",
    expectedTrackIds: tracks.map((track) =>
      plan.direction === "export" ? track.recordingMbid! : track.id
    ),
  }
  await journal.save(attempt)
  let admittedAccounts:
    Awaited<ReturnType<PlaylistAdapter["account"]>>[] | null = null
  try {
    admittedAccounts = await Promise.all([source.account(), target.account()])
  } catch {
    /* No remote write was sent. */
  }
  if (
    !isCurrent() ||
    !admittedAccounts ||
    !sameAccount(admittedAccounts[0], plan.source.account) ||
    !sameAccount(admittedAccounts[1], plan.target)
  ) {
    attempt = { ...attempt, state: "cancelled" }
    await journal.save(attempt)
    throw new PlaylistCopyError(
      "Playlist account changed. No request was sent.",
      attempt
    )
  }
  try {
    const created = await target.createCopy(plan.title, tracks, plan.target)
    attempt = { ...attempt, destinationId: created.id, state: "created" }
    await journal.save(attempt)
    if (!isCurrent() || !sameAccount(await target.account(), plan.target))
      return attempt
    const result = await target.read(created.id)
    const ids = result.items.map((item) =>
      plan.direction === "export" ? item.track.recordingMbid : item.track.id
    )
    const verified =
      sameAccount(result.account, plan.target) &&
      result.title === plan.title &&
      JSON.stringify(ids) === JSON.stringify(attempt.expectedTrackIds)
    attempt = { ...attempt, state: verified ? "verified" : "reconcile" }
    await journal.save(attempt)
    return attempt
  } catch {
    attempt = { ...attempt, state: "reconcile" }
    try {
      await journal.save(attempt)
    } catch {
      throw new PlaylistCopyError(
        "Playlist receipt could not be saved. Keep this view open and retry local retention before continuing.",
        attempt
      )
    }
    throw new PlaylistCopyError(
      "Playlist outcome needs checking. Review the destination before trying again.",
      attempt
    )
  }
}

/** Explicit reconciliation for a known or user-selected destination; never a replay of a failed write. */
export async function reconcilePlaylistAttempt(
  attempt: PlaylistAttempt,
  target: PlaylistAdapter,
  journal: PlaylistAttemptJournal,
  destinationId: string
): Promise<PlaylistAttempt> {
  const currentAccount = await target.account()
  // Explicit read-only reconciliation may use a renewed login for the same real
  // account. Admission/replay remains revision-bound; old receipts are not rebound.
  if (!samePlaylistIdentity(currentAccount, attempt.account))
    throw Error(
      "Connect the original playlist account before reviewing this copy"
    )
  const result = await target.read(destinationId)
  const ids = result.items.map((item) =>
    attempt.account.service === "listenbrainz"
      ? item.track.recordingMbid
      : item.track.id
  )
  if (
    !sameAccount(result.account, currentAccount) ||
    result.title !== attempt.title ||
    JSON.stringify(ids) !== JSON.stringify(attempt.expectedTrackIds)
  )
    throw Error("This playlist does not match the retained copy receipt")
  const verified: PlaylistAttempt = {
    ...attempt,
    state: "verified",
    destinationId,
  }
  await journal.save(verified)
  return verified
}

/** Explicit local disposition, never a claim that the remote operation did not happen. */
export async function dismissUnknownPlaylistAttempt(
  attempt: PlaylistAttempt,
  target: PlaylistAdapter,
  journal: PlaylistAttemptJournal,
  isCurrent: () => boolean,
  acknowledgedDuplicateRisk: boolean
): Promise<PlaylistAttempt> {
  if (
    !acknowledgedDuplicateRisk ||
    attempt.destinationId ||
    !["admitting", "reconcile"].includes(attempt.state)
  )
    throw Error(
      "Inspect the unknown destination and acknowledge the duplicate risk first"
    )
  const reviewedAccount = await target.account()
  if (!isCurrent() || !samePlaylistIdentity(reviewedAccount, attempt.account))
    throw Error("Connect the original account before reviewing this copy")
  const confirmedAccount = await target.account()
  if (!isCurrent() || !sameAccount(confirmedAccount, reviewedAccount))
    throw Error("Account changed while reviewing this copy")
  const dismissed: PlaylistAttempt = {
    ...attempt,
    state: "dismissed",
    dismissedAt: Date.now(),
    dismissalReason: "manual-unknown-outcome",
    reviewedAccount,
  }
  try {
    await journal.save(dismissed)
  } catch {
    throw new PlaylistCopyError(
      "The local dismissal could not be saved. Retry local retention; no remote request was sent.",
      dismissed
    )
  }
  return dismissed
}
