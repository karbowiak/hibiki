import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export interface YoutubeMusicStatus {
  enabled: boolean
  phase:
    | "disconnected"
    | "connecting"
    | "connected"
    | "refreshing"
    | "reauthRequired"
    | "unavailable"
  lastCheckedAt: number | null
  nextRefreshAt: number | null
  message: string | null
  accountId?: string | null
}
export interface YoutubeMusicSong {
  unavailable?: boolean
  videoId: string
  title: string
  artist: string
  album: string | null
  duration: string | null
  thumbnail: string | null
}
export interface YoutubeMusicStreamTest {
  videoId: string
  title: string
  sampleRate: number
  channels: number
  decodedMs: number
  checkedBytes: number
  bitrate: number | null
  checkedAt: number
}
export interface YoutubeMusicHelpers {
  ytDlp: boolean
  javascriptRuntime: boolean
  managed: boolean
  installing: boolean
  progress: number | null
}
export interface YoutubeMusicApi {
  status(): Promise<YoutubeMusicStatus>
  connect(): Promise<void>
  refresh(): Promise<void>
  disconnect(): Promise<void>
  helpers(): Promise<YoutubeMusicHelpers>
  installHelpers(): Promise<YoutubeMusicHelpers>
  subscribeHelpers(
    receive: (helpers: YoutubeMusicHelpers) => void
  ): Promise<() => void>
  search(query: string): Promise<YoutubeMusicSong[]>
  testStream(videoId: string): Promise<YoutubeMusicStreamTest>
  subscribe(receive: (status: YoutubeMusicStatus) => void): Promise<() => void>
}
export const youtubeMusicApi: YoutubeMusicApi = {
  status: () => invoke("ytmusic_status"),
  connect: () => invoke("ytmusic_connect"),
  refresh: () => invoke("ytmusic_refresh"),
  disconnect: () => invoke("ytmusic_disconnect"),
  helpers: () => invoke("ytmusic_helpers"),
  installHelpers: () => invoke("ytmusic_install_helpers"),
  subscribeHelpers: (receive) =>
    listen<YoutubeMusicHelpers>("ytmusic://tools", (event) =>
      receive(event.payload)
    ),
  search: async (query) => {
    const { browseYoutubeMusic } = await import("./discovery")
    const page = await browseYoutubeMusic({ browseId: "hibiki_song_search", params: query.trim() })
    return page.items.filter(item => item.kind === "song").slice(0, 20).map(item => ({
      videoId: item.id, title: item.title, artist: item.artist, album: item.album,
      duration: item.duration, thumbnail: item.thumbnail,
    }))
  },
  testStream: (videoId) => invoke("ytmusic_test_stream", { videoId }),
  subscribe: (receive) =>
    listen<YoutubeMusicStatus>("ytmusic://status", (event) =>
      receive(event.payload)
    ),
}
