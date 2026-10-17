import { browseYoutubeMusic } from "./discovery"
import { isYoutubeMusicId } from "./tracks"

export async function youtubeMusicLyrics(id: string) {
  if (!isYoutubeMusicId(id)) throw Error("Choose a valid YouTube Music song.")
  const page = await browseYoutubeMusic({ browseId: "hibiki_song_lyrics", params: id.slice(8) })
  if (!page.lyrics || (!page.lyrics.missing && !page.lyrics.lines.some(line => line.text.trim())))
    throw Error("YouTube Music did not return this song's lyrics.")
  return page.lyrics
}
