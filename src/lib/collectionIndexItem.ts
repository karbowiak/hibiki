import type { MusicItem } from "../types/music"

const indexItem = Symbol("collection-index")
export const isCollectionIndexItem = (item: unknown): boolean =>
  !!item?.[indexItem]
/** Only ordering/grouping fields survive a global index. Pages hydrate by ID. */
export function collectionIndexItem(item: MusicItem): MusicItem {
  const keys = [
    "id",
    "type",
    "title",
    "artistId",
    "artistName",
    "albumId",
    "albumName",
    "albumYear",
    "year",
    "trackNumber",
    "discNumber",
    "trackCount",
    "guid",
    "duration",
    "playCount",
    "viewCount",
    "userRating",
    "ratingCount",
    "parentStudio",
    "addedAt",
    "lastPlayedAt",
    "lastRatedAt",
    "likedAt",
    "codec",
    "bitrate",
    "bitDepth",
    "samplingRate",
    "channels",
    "_alternateIds",
  ]
  const result = {
    ...Object.fromEntries(
      keys.filter((key) => item[key] != null).map((key) => [key, item[key]])
    ),
    id: item.id,
    type: item.type,
  }
  return Object.assign({ id: item.id, type: item.type, title: "", artistName: "", albumName: "", year: 0, trackNumber: 0, duration: 0, playCount: 0, trackCount: 0 }, result, { [indexItem]: true }) as unknown as MusicItem
}
