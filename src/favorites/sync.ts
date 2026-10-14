import {
  bindFavorites,
  mergeFavoriteSnapshot,
  acknowledgeFavorite,
  favoritePlaylistHash,
  lastfmFavoriteKey,
} from "./model"
import { sameAccount, type PlaylistAccount } from "../playlistSync/types"
import type {
  FavoriteRecording,
  FavoritePage,
  FavoritePlexSnapshot,
  FavoriteRepository,
  FavoriteService,
  FavoritePending,
} from "./types"

export interface FavoriteSyncServices {
  account(service: FavoriteService): Promise<PlaylistAccount>
  page(account: PlaylistAccount, offset: number): Promise<FavoritePage>
  peek(account: PlaylistAccount, record: FavoriteRecording): Promise<boolean>
  set(
    account: PlaylistAccount,
    record: FavoriteRecording,
    liked: boolean,
    before: boolean
  ): Promise<boolean>
  plexRead(id: string): Promise<FavoritePlexSnapshot>
  plexCreate(): Promise<string>
  plexMutate(
    id: string,
    hash: string,
    operation: NonNullable<FavoritePending["operation"]>
  ): Promise<FavoritePlexSnapshot>
}
const SIDES: FavoriteService[] = ["plex", "listenbrainz", "lastfm"]
function reference(item: FavoriteRecording): FavoriteRecording {
  return {
    key: item.key,
    title: item.title,
    artist: item.artist,
    album: item.album ?? "",
    durationMs: item.durationMs,
    likedAt: item.likedAt,
    recordingMbid: item.recordingMbid,
    recordingMsid: item.recordingMsid,
    localTrackId: item.localTrackId,
  }
}
export async function readFavoriteRoster(
  account: PlaylistAccount,
  services: Pick<FavoriteSyncServices, "page">,
  current: () => boolean
): Promise<FavoriteRecording[]> {
  const rows: FavoriteRecording[] = [],
    seen = new Set<string>()
  let total: number | undefined
  do {
    if (!current()) throw Error("Favorite owner changed")
    const page = await services.page(account, rows.length)
    if (!current()) throw Error("Favorite owner changed")
    if (
      page.offset !== rows.length ||
      page.rows.length > 100 ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      page.total > 100000 ||
      (total !== undefined && total !== page.total) ||
      rows.length + page.rows.length > page.total ||
      (!page.rows.length && rows.length < page.total)
    )
      throw Error("Incomplete favorite roster")
    total = page.total
    for (const row of page.rows) {
      if (!row.key || seen.has(row.key))
        throw Error("Repeated favorite roster page")
      seen.add(row.key)
      rows.push(row)
    }
  } while (rows.length < total!)
  return rows
}
const rosterKey = (rows: FavoriteRecording[]) =>
  JSON.stringify(rows.map((row) => row.key).sort())
/** Likes are membership, not playlist order. Unknown verbs are reconciled by reads. */
export async function syncFavorites(
  repository: FavoriteRepository,
  services: FavoriteSyncServices,
  current: () => boolean,
  options: {
    retryUnknown?: boolean
    maxWrites?: number
    onIssue?: (service: FavoriteService, message: string) => void
  } = {}
): Promise<void> {
  const owns = () => {
    if (!current()) throw Error("Favorite owner changed")
  }
  let budget = options.maxWrites ?? 20
  for (const service of SIDES) {
    owns()
    if (!repository.read().settings[service]) continue
    try {
      const account = await services.account(service)
      owns()
      await repository.update((state) =>
        state.settings[service] ? bindFavorites(state, service, account) : state
      )
      owns()
      const enabled = () =>
        current() &&
        repository.read().settings[service] &&
        sameAccount(repository.read().bindings[service]!.account, account)
      let binding = repository.read().bindings[service]!
      if (service === "plex" && !binding.playlistId) {
        if (binding.creation) {
          if (!binding.creation.destinationId)
            throw Error(
              "Plex playlist creation needs inspection; select its original destination in Sync settings"
            )
          const inspected = await services.plexRead(
            binding.creation.destinationId
          )
          owns()
          if (inspected.title !== "Liked Songs" || inspected.items.length)
            throw Error(
              "Inspect the original empty Plex destination before recovering creation"
            )
          await repository.update((state) => ({
            ...state,
            bindings: {
              ...state.bindings,
              plex: {
                ...state.bindings.plex!,
                playlistId: binding.creation!.destinationId,
                creation: undefined,
              },
            },
          }))
        } else {
          if (!enabled() || !budget) continue
          await repository.update((state) => ({
            ...state,
            bindings: {
              ...state.bindings,
              plex: {
                ...state.bindings.plex!,
                creation: { state: "admitting" },
              },
            },
          }))
          owns()
          if (!enabled()) {
            await repository.update((state) => ({
              ...state,
              bindings: {
                ...state.bindings,
                plex: { ...state.bindings.plex!, creation: undefined },
              },
            }))
            continue
          }
          try {
            const id = await services.plexCreate()
            owns()
            budget--
            await repository.update((state) => ({
              ...state,
              bindings: {
                ...state.bindings,
                plex: {
                  ...state.bindings.plex!,
                  creation: { state: "created", destinationId: id },
                },
              },
            }))
            const inspected = await services.plexRead(id)
            owns()
            if (inspected.title !== "Liked Songs" || inspected.items.length)
              throw Error("Created Plex playlist needs inspection")
            await repository.update((state) => ({
              ...state,
              bindings: {
                ...state.bindings,
                plex: {
                  ...state.bindings.plex!,
                  playlistId: id,
                  creation: undefined,
                },
              },
            }))
          } catch (error) {
            if (current())
              await repository.update((state) => ({
                ...state,
                bindings: {
                  ...state.bindings,
                  plex: {
                    ...state.bindings.plex!,
                    creation: {
                      ...state.bindings.plex!.creation!,
                      state: "unknown",
                    },
                  },
                },
              }))
            throw error
          }
        }
        binding = repository.read().bindings[service]!
      }
      let plex: FavoritePlexSnapshot | undefined
      if (service === "plex")
        plex = await services.plexRead(binding.playlistId!)
      const first =
        plex?.rows ?? (await readFavoriteRoster(account, services, enabled))
      owns()
      const second =
        service === "plex"
          ? (await services.plexRead(binding.playlistId!)).rows
          : await readFavoriteRoster(account, services, enabled)
      owns()
      if (rosterKey(first) !== rosterKey(second))
        throw Error("Favorite list changed during reading; retry when stable")
      // Recover before importing the roster, so an old uncertain write is not mistaken for a new user edit.
      let pending = repository.read().bindings[service]!.pending
      if (pending) {
        const actual =
          service === "plex"
            ? await favoritePlaylistHash(
                plex!.title,
                plex!.items.map((item) => item.trackId)
              )
            : await services.peek(account, pending.recording)
        owns()
        const applied =
          service === "plex"
            ? actual === pending.afterHash
            : actual === pending.liked
        if (applied) {
          await settlePending(repository, service, pending, plex)
        } else {
          const unchanged =
            service === "plex"
              ? actual === pending.beforeHash
              : actual === pending.before
          if (!options.retryUnknown || !unchanged)
            throw Error(
              "An unconfirmed favorite change needs review before retrying"
            )
          await repository.update((state) => ({
            ...state,
            bindings: {
              ...state.bindings,
              [service]: { ...state.bindings[service]!, pending: undefined },
            },
          }))
        }
      }
      if (!enabled()) continue
      await repository.update((state) =>
        mergeFavoriteSnapshot(state, service, first, true)
      )
      owns()
      while (budget > 0 && enabled()) {
        const state = repository.read()
        const stillLovedIds = new Set(
          Object.values(state.entries)
            .filter((item) => item.liked)
            .flatMap((item) => item.localTrackIds)
        )
        const candidates = Object.values(state.entries).filter((item) => {
          const prior = item.sources[service]?.liked ?? false
          return (
            prior !== item.liked &&
            (service !== "plex" ||
              (item.localTrackIds.length > 0 &&
                (item.liked ||
                  !item.localTrackIds.some((id) => stillLovedIds.has(id)))))
          )
        })
        let item = candidates.find(
          (item) =>
            service !== "listenbrainz" ||
            !!(item.recordingMbid || item.recordingMsid)
        )
        if (service === "lastfm")
          item = candidates.find(
            (item) =>
              item.title &&
              item.artist &&
              (item.liked ||
                !Object.values(state.entries).some(
                  (other) =>
                    other.liked &&
                    lastfmFavoriteKey(other) === lastfmFavoriteKey(item)
                ))
          )
        if (!item) break
        let recording = reference(item),
          operation: FavoritePending["operation"],
          beforeHash: string | undefined,
          afterHash: string | undefined,
          entryIds: string[] | undefined
        let before = item.sources[service]?.liked ?? false
        if (service === "plex") {
          plex = await services.plexRead(binding.playlistId!)
          owns()
          const ids = plex.items.map((row) => row.trackId)
          beforeHash = await favoritePlaylistHash(plex.title, ids)
          if (item.liked) {
            const additions = candidates
              .filter(
                (row) =>
                  row.liked && !row.localTrackIds.some((id) => ids.includes(id))
              )
              .slice(0, 100)
            if (!additions.length) {
              await repository.update((state) =>
                acknowledgeFavorite(
                  state,
                  service,
                  item!.id,
                  true,
                  `local:${item!.localTrackIds.find((id) => ids.includes(id))!}`
                )
              )
              continue
            }
            const addIds = [
              ...new Set(additions.map((row) => row.localTrackIds[0])),
            ]
            entryIds = additions.map((row) => row.id)
            operation = { kind: "append", ids: addIds }
            afterHash = await favoritePlaylistHash(plex.title, [
              ...ids,
              ...addIds,
            ])
          } else {
            const index = ids.findIndex((id) =>
              item!.localTrackIds.includes(id)
            )
            if (index < 0) {
              await repository.update((state) =>
                acknowledgeFavorite(
                  state,
                  service,
                  item!.id,
                  false,
                  item!.sources.plex?.key ?? `local:${item!.localTrackIds[0]}`
                )
              )
              continue
            }
            operation = { kind: "delete", index }
            entryIds = [item.id]
            afterHash = await favoritePlaylistHash(
              plex.title,
              ids.filter((_, i) => i !== index)
            )
          }
        } else {
          before = await services.peek(account, recording)
          owns()
          if (before === item.liked) {
            await repository.update((state) =>
              acknowledgeFavorite(
                state,
                service,
                item!.id,
                before,
                service === "lastfm"
                  ? lastfmFavoriteKey(item!)
                  : recording.recordingMbid
                    ? `mbid:${recording.recordingMbid}`
                    : `msid:${recording.recordingMsid}`
              )
            )
            continue
          }
        }
        owns()
        if (!enabled()) break
        pending = {
          id: crypto.randomUUID(),
          entryId: item.id,
          entryIds,
          recording,
          liked: item.liked,
          before,
          state: "admitting",
          operation,
          beforeHash,
          afterHash,
        }
        const admitted = pending
        await repository.update((state) => ({
          ...state,
          bindings: {
            ...state.bindings,
            [service]: { ...state.bindings[service]!, pending: admitted },
          },
        }))
        owns()
        if (!enabled()) {
          await repository.update((state) => ({
            ...state,
            bindings: {
              ...state.bindings,
              [service]: { ...state.bindings[service]!, pending: undefined },
            },
          }))
          break
        }
        try {
          if (service === "plex") {
            plex = await services.plexMutate(
              binding.playlistId!,
              beforeHash!,
              operation!
            )
            owns()
            if (
              (await favoritePlaylistHash(
                plex.title,
                plex.items.map((item) => item.trackId)
              )) !== afterHash
            )
              throw Error("Plex favorite proof changed")
          } else {
            const result = await services.set(
              account,
              recording,
              admitted.liked,
              admitted.before
            )
            owns()
            if (result !== admitted.liked)
              throw Error("Favorite change was not verified")
          }
          await settlePending(repository, service, admitted, plex)
          budget--
        } catch (error) {
          if (current())
            await repository.update((state) => ({
              ...state,
              bindings: {
                ...state.bindings,
                [service]: {
                  ...state.bindings[service]!,
                  pending: { ...admitted, state: "unknown" },
                },
              },
            }))
          throw error
        }
      }
    } catch (error) {
      owns()
      options.onIssue?.(
        service,
        error instanceof Error
          ? error.message
          : typeof error === "string" && error.trim()
            ? error
            : "Favorite sync could not be confirmed"
      )
    }
  }
}
async function settlePending(
  repository: FavoriteRepository,
  service: FavoriteService,
  pending: FavoritePending,
  plex?: FavoritePlexSnapshot
) {
  await repository.update((state) => {
    if (state.bindings[service]?.pending?.id !== pending.id)
      throw Error("Favorite receipt changed")
    let next = state
    for (const id of pending.entryIds ?? [pending.entryId]) {
      const item = next.entries[id]
      if (!item) continue
      const present =
        service === "plex"
          ? !!plex?.items.some((row) =>
              item.localTrackIds.includes(row.trackId)
            )
          : pending.liked
      const key =
        service === "plex"
          ? (item.sources.plex?.key ?? `local:${item.localTrackIds[0]}`)
          : service === "lastfm"
            ? lastfmFavoriteKey(item)
            : pending.recording.recordingMbid
              ? `mbid:${pending.recording.recordingMbid}`
              : `msid:${pending.recording.recordingMsid}`
      next = acknowledgeFavorite(next, service, id, present, key)
    }
    return {
      ...next,
      bindings: {
        ...next.bindings,
        [service]: { ...next.bindings[service]!, pending: undefined },
      },
    }
  })
}
