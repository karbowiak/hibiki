import { get, update } from "idb-keyval"
import { playlistJournalDatabase } from "./journal"
import { validateSnapshot, snapshotRevision } from "./planner"
import {
  sameAccount,
  samePlaylistIdentity,
  type PlaylistAccount,
  type PlaylistAdapter,
  type PlaylistSnapshot,
} from "./types"
import { validWeeklyEdition, type WeeklyEdition } from "./weekly"
import type { LinkedPlaylist } from "./linked"
import type { LinkedPlaylistRepository } from "./linkedJournal"
const KEY = "linked-playlist-creations-v1"
export interface SyncCreationIntent {
  id: string
  key: string
  createdAt: number
  target: PlaylistAccount
  sourceSnapshot: PlaylistSnapshot
  title: string
  weeklyEdition?: WeeklyEdition
  state: "admitting" | "created" | "linked" | "reconcile" | "cancelled"
  destinationId?: string
  linkId?: string
}
export interface SyncCreationJournal {
  load(): Promise<SyncCreationIntent[]>
  save(intent: SyncCreationIntent): Promise<void>
}
export class SyncCreationError extends Error {
  constructor(
    message: string,
    readonly intent: SyncCreationIntent,
    readonly unretained = false
  ) {
    super(message)
  }
}
export function syncCreationKey(
  source: PlaylistSnapshot,
  target: PlaylistAccount,
  weeklyEdition?: WeeklyEdition
): string {
  return JSON.stringify([
    source.account.service,
    source.account.user,
    target.service,
    target.user,
    weeklyEdition?.family ?? source.id,
  ])
}
function valid(intent: SyncCreationIntent) {
  validateSnapshot(intent.sourceSnapshot)
  if (
    !intent.id ||
    intent.id.length > 128 ||
    intent.title.length > 500 ||
    !intent.title.trim() ||
    !intent.target.service ||
    !intent.target.user ||
    !intent.target.revision ||
    intent.key !==
      syncCreationKey(
        intent.sourceSnapshot,
        intent.target,
        intent.weeklyEdition
      ) ||
    (intent.destinationId !== undefined &&
      (!intent.destinationId || intent.destinationId.length > 500)) ||
    (intent.weeklyEdition &&
      (!validWeeklyEdition(
        intent.weeklyEdition,
        intent.sourceSnapshot.account
      ) ||
        intent.weeklyEdition.playlistId !== intent.sourceSnapshot.id)) ||
    !["admitting", "created", "linked", "reconcile", "cancelled"].includes(
      intent.state
    )
  )
    throw Error("Invalid sync creation recovery state")
}
export function retainSyncCreation(
  previous: SyncCreationIntent[],
  intent: SyncCreationIntent
): SyncCreationIntent[] {
  if (!Array.isArray(previous) || previous.length > 64)
    throw Error("Invalid sync creation journal")
  previous.forEach(valid)
  valid(intent)
  const old = previous.find((item) => item.id === intent.id)
  if (
    old &&
    (old.key !== intent.key ||
      old.title !== intent.title ||
      snapshotRevision(old.sourceSnapshot) !==
        snapshotRevision(intent.sourceSnapshot) ||
      !sameAccount(old.target, intent.target) ||
      (old.destinationId && old.destinationId !== intent.destinationId) ||
      (["linked", "cancelled"].includes(old.state) &&
        intent.state !== old.state))
  )
    throw Error("Sync creation receipt cannot be replaced")
  if (
    !old &&
    previous.some(
      (item) =>
        item.key === intent.key &&
        item.state !== "linked" &&
        item.state !== "cancelled"
    )
  )
    throw Error(
      "A previous creation for this source needs inspection; no new playlist was requested"
    )
  const rows = [
    ...previous.filter((item) => item.id !== intent.id),
    structuredClone(intent),
  ]
  const pending = rows.filter(
    (item) => item.state !== "linked" && item.state !== "cancelled"
  )
  if (pending.length > 32)
    throw Error("Review unresolved playlist creations before creating another")
  return [
    ...pending,
    ...rows
      .filter((item) => item.state === "linked" || item.state === "cancelled")
      .slice(-32),
  ]
}
export const syncCreationJournal: SyncCreationJournal = {
  load: async () => {
    const rows =
      (await get<SyncCreationIntent[]>(KEY, playlistJournalDatabase())) ?? []
    if (!Array.isArray(rows) || rows.length > 64)
      throw Error("Sync creation recovery could not be read")
    rows.forEach(valid)
    return rows
  },
  save: async (intent) => {
    await update<SyncCreationIntent[]>(
      KEY,
      (previous) => retainSyncCreation(previous ?? [], intent),
      playlistJournalDatabase()
    )
  },
}
export interface SyncCreationServices {
  source: PlaylistAdapter
  target: PlaylistAdapter
  journal: SyncCreationJournal
  links: LinkedPlaylistRepository
  current(): boolean
  admissionCurrent?(): boolean
}
/** A separate sync admission: the full source stays retained while the new destination starts empty. */
export async function createLinkedSync(
  sourceId: string,
  title: string,
  services: SyncCreationServices,
  weeklyEdition?: WeeklyEdition
): Promise<{ intent: SyncCreationIntent; link: LinkedPlaylist }> {
  const source = await services.source.read(sourceId),
    target = await services.target.account()
  validateSnapshot(source)
  if (
    source.id !== sourceId ||
    !services.current() ||
    services.admissionCurrent?.() === false ||
    !services.target.capabilities.createCopy ||
    !title.trim() ||
    title.trim().length > 500
  )
    throw Error("Sync creation owner or title changed")
  if (
    weeklyEdition &&
    (weeklyEdition.playlistId !== source.id ||
      !validWeeklyEdition(weeklyEdition, source.account))
  )
    throw Error("Review the weekly source identity before creating a playlist")
  const existing = await services.links.load()
  if (
    existing.some(
      (link) =>
        samePlaylistIdentity(link.library, target) &&
        samePlaylistIdentity(link.listenbrainz, source.account) &&
        (weeklyEdition
          ? link.weeklySource?.family === weeklyEdition.family
          : link.listenbrainzPlaylistId === source.id)
    )
  )
    throw Error(
      "This source already has a library playlist; configure its existing sync"
    )
  let intent: SyncCreationIntent = {
    id: crypto.randomUUID(),
    key: syncCreationKey(source, target, weeklyEdition),
    createdAt: Date.now(),
    target,
    sourceSnapshot: structuredClone(source),
    title: title.trim(),
    weeklyEdition,
    state: "admitting",
  }
  if (services.admissionCurrent?.() === false)
    throw Error("Sync creation view changed before admission")
  await services.journal.save(intent)
  if (
    !services.current() ||
    !sameAccount(await services.target.account(), target) ||
    !sameAccount(await services.source.account(), source.account) ||
    !services.current()
  ) {
    intent = { ...intent, state: "cancelled" }
    await services.journal.save(intent)
    throw new SyncCreationError(
      "Connection changed. No playlist was created.",
      intent
    )
  }
  try {
    const created = await services.target.createCopy(intent.title, [], target)
    intent = { ...intent, destinationId: created.id, state: "created" }
    try {
      await services.journal.save(intent)
    } catch {
      throw new SyncCreationError(
        "The playlist ID could not be retained. Retry saving this receipt; do not create another playlist.",
        intent,
        true
      )
    }
    if (!services.current())
      throw new SyncCreationError(
        "The playlist was created in the original library. Inspect its retained receipt before continuing.",
        intent
      )
    return await reconcileSyncCreation(intent, services)
  } catch (error) {
    if (error instanceof SyncCreationError) throw error
    intent = { ...intent, state: "reconcile" }
    try {
      await services.journal.save(intent)
    } catch {
      throw new SyncCreationError(
        "Creation recovery could not be retained. Keep this view open and retry saving the receipt.",
        intent,
        true
      )
    }
    throw new SyncCreationError(
      "Playlist creation outcome needs inspection before any retry.",
      intent
    )
  }
}
/** Known-ID recovery performs reads/local retention only, never another remote create. */
export async function reconcileSyncCreation(
  intent: SyncCreationIntent,
  services: SyncCreationServices
): Promise<{ intent: SyncCreationIntent; link: LinkedPlaylist }> {
  valid(intent)
  if (
    !intent.destinationId ||
    !services.current() ||
    !samePlaylistIdentity(await services.target.account(), intent.target)
  )
    throw new SyncCreationError(
      "Inspect the original destination before recovering this creation.",
      intent
    )
  const retained = await services.links.load()
  if (
    !services.current() ||
    !samePlaylistIdentity(
      await services.source.account(),
      intent.sourceSnapshot.account
    )
  )
    throw new SyncCreationError("Creation account changed", intent)
  if (!services.current())
    throw new SyncCreationError("Creation account changed", intent)
  const existing = retained.find(
    (link) =>
      link.libraryPlaylistId === intent.destinationId &&
      samePlaylistIdentity(link.library, intent.target) &&
      link.listenbrainzPlaylistId === intent.sourceSnapshot.id &&
      samePlaylistIdentity(link.listenbrainz, intent.sourceSnapshot.account)
  )
  if (existing) {
    const completed = {
      ...intent,
      state: "linked" as const,
      linkId: existing.id,
    }
    await services.journal.save(completed)
    return { intent: completed, link: existing }
  }
  const destination = await services.target.read(intent.destinationId)
  if (
    !services.current() ||
    destination.id !== intent.destinationId ||
    !samePlaylistIdentity(destination.account, intent.target) ||
    destination.title !== intent.title ||
    destination.items.length
  )
    throw new SyncCreationError(
      "The created playlist is not the expected empty destination. Inspect it before linking; nothing was overwritten.",
      intent
    )
  const source = intent.sourceSnapshot
  const link: LinkedPlaylist = {
    version: 1,
    revision: 0,
    id: crypto.randomUUID(),
    library: intent.target,
    listenbrainz: source.account,
    libraryPlaylistId: destination.id,
    listenbrainzPlaylistId: source.id,
    enabled: true,
    paused: false,
    direction: "import",
    automatic: !!intent.weeklyEdition,
    baseline: { library: destination, listenbrainz: source },
    mappings: [],
    state: "ready",
    incomplete: {
      sourceSnapshot: source,
      missingOccurrenceIds: source.items.map((item) => item.occurrenceId),
      matchedCount: 0,
      total: source.items.length,
      matchingCursor: 0,
      matchingDone: false,
    },
    ...(intent.weeklyEdition
      ? {
          weeklySource: {
            family: intent.weeklyEdition.family,
            recipient: intent.weeklyEdition.recipient,
            edition: intent.weeklyEdition,
            pendingSourceSnapshot: source,
          },
        }
      : {}),
  }
  const saved = await services.links.save(link, null)
  const completed = { ...intent, state: "linked" as const, linkId: saved.id }
  try {
    await services.journal.save(completed)
  } catch {
    throw new SyncCreationError(
      "The playlist link was retained but its creation receipt still needs saving. Do not create another playlist.",
      completed,
      true
    )
  }
  return { intent: completed, link: saved }
}
