import { useSyncExternalStore } from "react"
import { createScalarPreference } from "../../stores/scalarPreference"
import type { MusicTrack } from "../../types/music"
import { isYoutubeMusicId } from "./tracks"
import type { YoutubeMusicItem } from "./discovery"

type PlayedItem = YoutubeMusicItem & { playedAt: number }
const history = createScalarPreference<PlayedItem[]>("hibiki-ytmusic-play-history", [], raw => {
  const value = JSON.parse(raw)
  if (!Array.isArray(value) || value.length > 200 || value.some(item => !item ||
    !/^[A-Za-z0-9_-]{11}$/.test(item.id) || item.kind !== "song" || typeof item.title !== "string" ||
    typeof item.artist !== "string" || !Number.isFinite(item.playedAt))) throw Error("Invalid YouTube Music history")
  return value
}, JSON.stringify)

/** Record accepted native starts, including automatic mixed-queue transitions. */
export function rememberYoutubeMusicPlay(track: MusicTrack) {
  if (!isYoutubeMusicId(track.id)) return
  let thumbnail: string | null = null
  try {
    const image = new URL(track.thumbUrl ?? "")
    thumbnail = image.searchParams.get("src") ?? (image.protocol === "https:" ? image.href : null)
  } catch { /* Artwork is optional public metadata. */ }
  const seconds = Math.floor(track.duration / 1000)
  const item: PlayedItem = { id: track.id.slice(8), kind: "song", title: track.title,
    artist: track.artistName, album: track.albumName || null, year: track.year || null,
    duration: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    thumbnail, playedAt: Date.now() }
  history.set([item, ...history.snapshot().filter(saved => saved.id !== item.id)].slice(0, 200))
}
export function clearYoutubeMusicHistory() { history.set([]) }
export function useYoutubeMusicHistory() { return useSyncExternalStore(history.subscribe, history.snapshot) }
