import { create } from "zustand"
import { linkedPlaylistRepository } from "../playlistSync/linkedJournal"
import type { LinkedPlaylist } from "../playlistSync/linked"
interface State {
  holds: Record<string, true>
  hold(id: string, held: boolean): void
  links: LinkedPlaylist[]
  loading: boolean
  error: string | null
  checkedErrors: Record<string, string>
  load(): Promise<void>
  save(
    link: LinkedPlaylist,
    expectedRevision: number | null
  ): Promise<LinkedPlaylist>
  publish(link: LinkedPlaylist): void
  checkError(id: string, message: string | null): void
}
let version = 0
export const useLinkedPlaylistStore = create<State>((set, get) => ({
  holds: {},
  hold: (id, held) =>
    set((s) => ({
      holds: held
        ? { ...s.holds, [id]: true }
        : Object.fromEntries(
            Object.entries(s.holds).filter(([key]) => key !== id)
          ),
    })),
  links: [],
  loading: false,
  error: null,
  checkedErrors: {},
  load: async () => {
    const revision = ++version
    set({ loading: true })
    try {
      const links = await linkedPlaylistRepository.load()
      if (version === revision) set({ links, loading: false, error: null })
    } catch {
      if (version === revision)
        set({
          loading: false,
          error:
            "Linked playlist recovery settings could not be read. Sync is paused; retry local storage before continuing.",
        })
    }
  },
  save: async (link, expectedRevision) => {
    try {
      const saved = await linkedPlaylistRepository.save(link, expectedRevision)
      version++
      get().publish(saved)
      return saved
    } catch (error) {
      set({
        error:
          "Linked playlist changes could not be retained. Sync is paused. Reload local recovery settings before continuing.",
      })
      throw error
    }
  },
  publish: (link) =>
    set((s) => ({
      links: [...s.links.filter((item) => item.id !== link.id), link],
    })),
  checkError: (id, message) =>
    set((s) => ({
      checkedErrors: message
        ? { ...s.checkedErrors, [id]: message }
        : Object.fromEntries(
            Object.entries(s.checkedErrors).filter(([key]) => key !== id)
          ),
    })),
}))
