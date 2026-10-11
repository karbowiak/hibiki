import { useCallback } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useContextMenuStore, type ContextMenuType } from "../stores/contextMenuStore"
import type { MusicTrack, MusicAlbum, MusicArtist, MusicPlaylist } from "../types/music"

type ContextMenuData = MusicTrack | MusicAlbum | MusicArtist | MusicPlaylist

/**
 * Unified hook for context menu integration.
 *
 * Returns:
 * - `handler(type, data, playlistId?)` — builds an `onContextMenu` React handler
 * - `isTarget(id)` — true if this id's row should be highlighted
 */
export function useContextMenu() {
  const provider = useProviderStore(s => s.provider)
  const show = useContextMenuStore(s => s.show)
  const open = useContextMenuStore(s => s.open)
  const targetId = useContextMenuStore(s => (s.data as any)?.id ?? null)

  const handler = useCallback(
    (type: ContextMenuType, data: ContextMenuData, playlistId?: string | null) =>
      (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (useProviderStore.getState().provider !== provider) return
        show(e.clientX, e.clientY, type, data, playlistId)
      },
    [show, provider],
  )

  const isTarget = useCallback(
    (id: string) => open && targetId === id,
    [open, targetId],
  )

  return { handler, isTarget }
}
