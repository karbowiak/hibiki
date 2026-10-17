import { createRoot } from "react-dom/client"
import { isTauri } from "@tauri-apps/api/core"
import { YoutubeMusicConnection } from "../../../src/components/YoutubeMusicConnection"
import {
  youtubeMusicApi,
  type YoutubeMusicApi,
  type YoutubeMusicStatus,
} from "../../../src/backends/ytmusic/api"
import "../../../src/styles.css"

let status: YoutubeMusicStatus = {
  enabled: false,
  phase: "disconnected",
  lastCheckedAt: null,
  nextRefreshAt: null,
  message: null,
}
let receive: ((status: YoutubeMusicStatus) => void) | null = null
let receiveHelpers:
  ((value: Awaited<ReturnType<YoutubeMusicApi["helpers"]>>) => void) | null =
  null
let helpers = {
  ytDlp: false,
  javascriptRuntime: false,
  managed: false,
  installing: false,
  progress: null as number | null,
}
const update = (phase: YoutubeMusicStatus["phase"]) => {
  status = {
    ...status,
    enabled: phase !== "disconnected",
    phase,
    lastCheckedAt: phase === "connected" ? 1792256400 : status.lastCheckedAt,
    message:
      phase === "reauthRequired"
        ? "Sign in to YouTube Music again."
        : phase === "unavailable"
          ? "YouTube Music could not be reached. Try again."
          : null,
  }
  receive?.(status)
}
const fake: YoutubeMusicApi = {
  status: async () => status,
  connect: async () => {
    update("connecting")
  },
  refresh: async () => {
    update("connected")
  },
  disconnect: async () => {
    update("disconnected")
  },
  helpers: async () => helpers,
  subscribeHelpers: async (callback) => {
    receiveHelpers = callback
    return () => {
      receiveHelpers = null
    }
  },
  installHelpers: async () => {
    helpers = { ...helpers, installing: true, progress: 50 }
    receiveHelpers?.(helpers)
    await new Promise((resolve) => setTimeout(resolve, 100))
    helpers = {
      ytDlp: true,
      javascriptRuntime: true,
      managed: true,
      installing: false,
      progress: null,
    }
    receiveHelpers?.(helpers)
    return helpers
  },
  search: async () => [
    {
      videoId: "abcdefghijk",
      title: "Fixture song",
      artist: "Fixture artist",
      album: "Fixture album",
      duration: "3:14",
      thumbnail: null,
    },
  ],
  testStream: async () => ({
    videoId: "abcdefghijk",
    title: "Fixture song",
    sampleRate: 44100,
    channels: 2,
    decodedMs: 1021,
    checkedBytes: 524288,
    bitrate: 128,
    checkedAt: 1792256400,
  }),
  subscribe: async (callback) => {
    receive = callback
    return () => {
      receive = null
    }
  },
}
if (!isTauri()) (window as any).youtubeMusicFixture = { update }

createRoot(document.getElementById("root")!).render(
  <main className="bg-app-bg min-h-screen text-(--text-primary)">
    <div className="app-topbar bg-app-surface flex items-center justify-between border-b border-(--border) px-6 py-4">
      <span className="font-semibold">Hibiki · YouTube Music connection</span>
      <YoutubeMusicConnection
        api={isTauri() ? youtubeMusicApi : fake}

      />
    </div>
    <div className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold">YouTube Music connection</h1>
      <p className="mt-4 text-sm leading-relaxed text-(--text-secondary)">
        Manage your YouTube Music session and playback tools using the YTM
        button above.
      </p>

    </div>
  </main>
)
