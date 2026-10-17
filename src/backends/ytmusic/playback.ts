import { usePlayerStore } from "../../stores/playerStore"
import { youtubeMusicTrack } from "./tracks"
import type { YoutubeMusicSong } from "./api"

export interface YoutubeMusicPlayback {
  play(song: YoutubeMusicSong): Promise<void>
  enqueue(song: YoutubeMusicSong): void
}

export const youtubeMusicPlayback: YoutubeMusicPlayback = {
  play: (song) =>
    usePlayerStore
      .getState()
      .playTrack(youtubeMusicTrack(song), undefined, "YouTube Music"),
  enqueue: (song) =>
    usePlayerStore.getState().addToQueue([youtubeMusicTrack(song)]),
}
