import { create } from "zustand"
import type { CatalogueProgress } from "./catalogue"
import type { PlexRequestContext } from "../backends/plex/scopedApi"
export const useCatalogueStore = create<{
  context: PlexRequestContext | null
  progress: CatalogueProgress | null
  activate(context: PlexRequestContext | null): void
  update(context: PlexRequestContext, progress: CatalogueProgress): void
}>((set, get) => ({
  context: null,
  progress: null,
  activate: (context) => set({ context, progress: null }),
  update: (context, progress) => {
    if (
      context.connectionRevision === get().context?.connectionRevision &&
      context.cacheScope === get().context?.cacheScope
    )
      set({ progress })
  },
}))
