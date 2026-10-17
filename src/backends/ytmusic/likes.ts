import { create } from "zustand"
import { invoke } from "@tauri-apps/api/core"
import type { MusicTrack } from "../../types/music"
import type { YoutubeMusicItem } from "./discovery"
import { isYoutubeMusicId } from "./tracks"
import { useOfflineStatusStore } from "../../offline/statusStore"
import type { ContextAction } from "../../stores/contextMenuStore"

export interface YoutubeMusicLike {
  liked?: boolean
  checking: boolean
  saving: boolean
  error: string | null
  manual: boolean
  track?: MusicTrack
  changedAt?: string
}
interface LikesState {
  owner: number | null
  mutation: number
  entries: Record<string, YoutubeMusicLike>
  connect(owner: number | null): void
  observe(items: YoutubeMusicItem[], mutation?: number, authoritative?: boolean): void
  check(track: MusicTrack): Promise<boolean | undefined>
  toggle(track: MusicTrack): Promise<boolean>
}
interface Dependencies {
  read(videoId: string): Promise<boolean>
  write(videoId: string, liked: boolean): Promise<void>
}
const empty = (): YoutubeMusicLike => ({ checking: false, saving: false, error: null, manual: false })

/** One pending write per song, shared by every view; account changes retire it. */
export function createYoutubeMusicLikesStore(dependencies: Dependencies) {
  const checks = new Map<string, Promise<boolean | undefined>>()
  const versions = new Map<string, number>()
  return create<LikesState>((set, get) => {
    const put = (id: string, entry: YoutubeMusicLike) => set(state => ({ entries: { ...state.entries, [id]: entry } }))
    return {
      owner: null, mutation: 0, entries: {},
      connect: owner => {
        if (owner === get().owner) return
        checks.clear()
        versions.clear()
        set(state => ({ owner, entries: {}, mutation: state.mutation + 1 }))
      },
      observe: (items, mutation, authoritative = false) => {
        if (get().owner === null || (mutation !== undefined && mutation !== get().mutation)) return
        const entries = { ...get().entries }
        let changed = false
        for (const item of items) {
          if (item.kind !== "song" || typeof item.liked !== "boolean") continue
          const id = `ytmusic:${item.id}`, previous = entries[id]
          if (previous?.saving || (previous?.manual && (!authoritative ||
            (previous.liked !== item.liked && Date.now() - Date.parse(previous.changedAt ?? "") < 30_000)))) continue
          if (previous?.liked === item.liked && !previous.error) continue
          entries[id] = { ...empty(), ...previous, liked: item.liked, error: null, manual: false }
          changed = true
        }
        if (changed) set({ entries })
      },
      check: track => {
        const owner = get().owner, id = track.id
        if (owner === null || !isYoutubeMusicId(id)) return Promise.resolve(undefined)
        const known = get().entries[id]
        if (typeof known?.liked === "boolean") return Promise.resolve(known.liked)
        const key = `${owner}:${id}`, pending = checks.get(key)
        if (pending) return pending
        const version = versions.get(id)
        put(id, { ...empty(), ...known, checking: true, error: null })
        const work = (async () => {
          try {
            const liked = await dependencies.read(id.slice(8))
            if (get().owner !== owner || versions.get(id) !== version) return undefined
            put(id, { ...get().entries[id], liked, checking: false, error: null })
            return liked
          } catch (failure) {
            if (get().owner === owner && versions.get(id) === version)
              put(id, { ...get().entries[id], checking: false, error: String(failure) })
            return undefined
          }
        })()
        checks.set(key, work)
        void work.finally(() => { if (checks.get(key) === work) checks.delete(key) })
        return work
      },
      toggle: async track => {
        const owner = get().owner, id = track.id
        if (owner === null || !isYoutubeMusicId(id) || get().entries[id]?.saving) return false
        const previous = get().entries[id] ?? empty()
        put(id, { ...previous, saving: true, error: null, track })
        const before = await get().check(track)
        if (get().owner !== owner) return false
        if (typeof before !== "boolean") {
          put(id, { ...get().entries[id], saving: false, checking: false })
          return false
        }
        const liked = !before, mutation = get().mutation + 1
        versions.set(id, (versions.get(id) ?? 0) + 1)
        set({ mutation })
        put(id, { ...get().entries[id], liked, saving: true, manual: true, track, changedAt: new Date().toISOString() })
        try {
          await dependencies.write(id.slice(8), liked)
          if (get().owner !== owner) return false
          put(id, { ...get().entries[id], saving: false, checking: false, error: null })
          return true
        } catch (failure) {
          if (get().owner === owner) {
            put(id, { ...previous, liked: before, saving: false, checking: false, track,
              error: `Could not ${liked ? "like" : "unlike"} this song on YouTube Music. ${String(failure)}` })
          }
          return false
        }
      },
    }
  })
}

export const useYoutubeMusicLikesStore = createYoutubeMusicLikesStore({
  read: async videoId => {
    const { browseYoutubeMusic } = await import("./discovery")
    const page = await browseYoutubeMusic({ browseId: "hibiki_song_like", params: videoId })
    const song = page.items.find(item => item.kind === "song" && item.id === videoId)
    if (typeof song?.liked !== "boolean") throw Error("Could not read the song's like status. Try again.")
    return song.liked
  },
  write: (videoId, liked) => invoke("ytmusic_set_song_like", { videoId, liked }),
})

export function youtubeMusicLikeAction(track: MusicTrack): ContextAction {
  const state = useYoutubeMusicLikesStore.getState(), owner = state.owner
  const liked = state.entries[track.id]?.liked
  return {
    label: liked === undefined ? "Like / unlike on YouTube Music" : `${liked ? "Unlike" : "Like"} on YouTube Music`,
    run: async () => {
      if (owner === null || useYoutubeMusicLikesStore.getState().owner !== owner) throw Error("Connect YouTube Music to change likes.")
      if (useOfflineStatusStore.getState().offlineMode) throw Error("Connect to the internet to change YTM likes.")
      const saved = await useYoutubeMusicLikesStore.getState().toggle(track)
      if (!saved && useYoutubeMusicLikesStore.getState().owner === owner)
        throw Error(useYoutubeMusicLikesStore.getState().entries[track.id]?.error ?? "The like could not be saved. Try again.")
    },
  }
}
