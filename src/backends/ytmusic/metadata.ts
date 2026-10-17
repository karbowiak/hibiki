import { browseYoutubeMusic, youtubeMusicItemTrack } from "./discovery"
import { isYoutubeMusicId } from "./tracks"

/** Stable video identity, through the account-scoped native SWR cache. */
export async function youtubeMusicSongMetadata(id: string) {
  if (!isYoutubeMusicId(id)) throw Error("Choose a valid YouTube Music song.")
  const page = await browseYoutubeMusic({ browseId: "hibiki_song_metadata", params: id.slice(8) })
  const item = page.items.find(item => item.kind === "song" && `ytmusic:${item.id}` === id)
  if (!item) throw Error("YouTube Music did not return this song's metadata.")
  return youtubeMusicItemTrack(item)
}
