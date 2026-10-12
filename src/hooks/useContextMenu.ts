import { useCallback } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useContextMenuStore, type MediaContextMenuType, type ContextActionsData } from "../stores/contextMenuStore"
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
  const scope = provider?.cacheScope
  const showActions = useContextMenuStore(s => s.showActions)
  const show = useContextMenuStore(s => s.show)
  const open = useContextMenuStore(s => s.open)
  const targetId = useContextMenuStore(s => (s.data as any)?.id ?? null)

  const handler = useCallback(
    (type: MediaContextMenuType, data: ContextMenuData, playlistId?: string | null) =>
      (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (!provider || useProviderStore.getState().provider !== provider || provider.cacheScope !== scope) return
        const root = e.currentTarget as HTMLElement
        const target = (e.target as HTMLElement).closest?.("button, a[href]") ?? root.querySelector?.("button, a[href]")
        if (target instanceof window.HTMLElement) target.focus({ preventScroll: true })
        const bounds = root.getBoundingClientRect()
        const keyboard = e.clientX === 0 && e.clientY === 0
        show(keyboard ? bounds.left : e.clientX, keyboard ? bounds.bottom : e.clientY, type, data, playlistId)
      },
    [show, provider, scope],
  )

  const actionsHandler = useCallback(
    (data: ContextActionsData) => (e: React.MouseEvent) => {
      e.preventDefault(); e.stopPropagation()
      // Public audio cards remain usable with no music provider connected.
      if (useProviderStore.getState().provider !== provider || provider?.cacheScope !== scope) return
      const root = e.currentTarget as HTMLElement
      const target = (e.target as HTMLElement).closest?.("button, a[href]") ?? root.querySelector?.("button, a[href]")
      if (target instanceof window.HTMLElement) target.focus({ preventScroll: true })
      const bounds = root.getBoundingClientRect(), keyboard = e.clientX === 0 && e.clientY === 0
      showActions(keyboard ? bounds.left : e.clientX, keyboard ? bounds.bottom : e.clientY, data)
    }, [showActions, provider, scope]
  )

  const isTarget = useCallback(
    (id: string) => open && targetId === id,
    [open, targetId],
  )

  return { handler, actionsHandler, isTarget }
}
