import { recordingMbid } from "../playlistSync/matching"
import type { FavoriteEntry, FavoriteMetadata } from "./types"
const sides = ["plex", "lastfm", "listenbrainz"]
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown, max = 2048): value is string =>
  typeof value === "string" && value.length <= max
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
const localId = (value: unknown) =>
  text(value) && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
function recording(value: unknown) {
  return (
    object(value) &&
    text(value.key) &&
    !!value.key &&
    text(value.title, 1000) &&
    text(value.artist, 1000) &&
    (value.album === undefined || text(value.album, 1000)) &&
    (value.durationMs === undefined || number(value.durationMs)) &&
    ["recordingMbid", "recordingMsid"].every(
      (field) => value[field] == null || !!recordingMbid(value[field])
    )
  )
}
export function validFavorite(value: unknown): value is FavoriteEntry {
  return (
    recording(value) &&
    object(value) &&
    text(value.id) &&
    !!value.id &&
    typeof value.liked === "boolean" &&
    typeof value.explicit === "boolean" &&
    number(value.changedAt) &&
    Array.isArray(value.localTrackIds) &&
    value.localTrackIds.length <= 16 &&
    value.localTrackIds.every(localId) &&
    object(value.sources) &&
    Object.entries(value.sources).every(
      ([side, source]) =>
        sides.includes(side) &&
        object(source) &&
        text(source.key) &&
        typeof source.liked === "boolean" &&
        (source.desired === undefined || typeof source.desired === "boolean")
    )
  )
}
export function validFavoriteMetadata(
  value: unknown
): value is FavoriteMetadata {
  if (
    !object(value) ||
    value.version !== 1 ||
    !object(value.settings) ||
    !object(value.bindings) ||
    !sides.every(
      (side) =>
        typeof (value.settings as Record<string, unknown>)[side] === "boolean"
    ) ||
    ![2, 4, 6, 8, 10].includes(value.settings.ratingThreshold as number) ||
    (value.ratingsImported !== undefined &&
      typeof value.ratingsImported !== "boolean")
  )
    return false
  return Object.entries(value.bindings).every(([side, binding]) => {
    if (
      !sides.includes(side) ||
      !object(binding) ||
      !object(binding.account) ||
      !["service", "user", "revision"].every(
        (field) =>
          text((binding.account as Record<string, unknown>)[field]) &&
          !!(binding.account as Record<string, unknown>)[field]
      ) ||
      typeof binding.initialized !== "boolean"
    )
      return false
    if (binding.playlistId !== undefined && !localId(binding.playlistId))
      return false
    if (
      binding.creation !== undefined &&
      (!object(binding.creation) ||
        !["admitting", "unknown", "created"].includes(
          String(binding.creation.state)
        ) ||
        (binding.creation.destinationId !== undefined &&
          !localId(binding.creation.destinationId)))
    )
      return false
    if (binding.pending !== undefined) {
      const pending = binding.pending
      if (
        !object(pending) ||
        !text(pending.id) ||
        !text(pending.entryId) ||
        typeof pending.liked !== "boolean" ||
        typeof pending.before !== "boolean" ||
        !["admitting", "unknown"].includes(String(pending.state)) ||
        !recording(pending.recording)
      )
        return false
      if (
        pending.entryIds !== undefined &&
        (!Array.isArray(pending.entryIds) ||
          pending.entryIds.length > 100 ||
          !pending.entryIds.every((id) => text(id)))
      )
        return false
      if (
        side === "plex" &&
        (!text(pending.beforeHash) ||
          !text(pending.afterHash) ||
          !object(pending.operation) ||
          (pending.operation.kind === "append"
            ? !Array.isArray(pending.operation.ids) ||
              pending.operation.ids.length > 100 ||
              !pending.operation.ids.every(localId)
            : pending.operation.kind !== "delete" ||
              !number(pending.operation.index)))
      )
        return false
    }
    return true
  })
}
