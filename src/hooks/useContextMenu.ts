import { useCallback } from "react"
import { useLocation } from "wouter"
import { youtubeMusicContext } from "../backends/ytmusic/contextActions"
import { useProviderStore } from "../stores/providerStore"
import { useContextMenuStore, type MediaContextMenuType, type ContextActionsData, type ContextAction } from "../stores/contextMenuStore"
import type { MusicTrack, MusicAlbum, MusicArtist, MusicPlaylist, MusicItem } from "../types/music"
import { originalYoutubeMusicItem, type YoutubeMusicItem } from "../backends/ytmusic/discovery"

type ContextMenuData = MusicTrack | MusicAlbum | MusicArtist | MusicPlaylist

/**
 * Unified hook for context menu integration.
 *
 * Returns:
 * - `handler(type, data, playlistId?)` — builds an `onContextMenu` React handler
 * - `isTarget(id)` — true if this id's row should be highlighted
 */
export function useContextMenu() {
  const [, navigate] = useLocation()
  const provider = useProviderStore(s => s.provider)
  const scope = provider?.cacheScope
  const showActions = useContextMenuStore(s => s.showActions)
  const show = useContextMenuStore(s => s.show)
  const open = useContextMenuStore(s => s.open)
  const targetId = useContextMenuStore(s => (s.data as any)?.id ?? null)

  const handler = useCallback(
    (type: MediaContextMenuType, data: ContextMenuData, playlistId?: string | null, extraActions: readonly ContextAction[] = []) =>
      (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (useProviderStore.getState().provider !== provider || provider?.cacheScope !== scope) return
        const root = e.currentTarget as HTMLElement
        const target = (e.target as HTMLElement).closest?.("button, a[href]") ?? root.querySelector?.("button, a[href]")
        if (target instanceof window.HTMLElement) target.focus({ preventScroll: true })
        const bounds = root.getBoundingClientRect()
        const keyboard = e.clientX === 0 && e.clientY === 0
        if (data.id.startsWith("ytmusic:")) {
          const raw = originalYoutubeMusicItem({ ...data, type } as MusicItem)
          const item: YoutubeMusicItem = raw ?? {
            id: data.id.slice(8), kind: type === "track" ? "song" : type, title: data.title,
            artist: "artistName" in data ? data.artistName : "", album: type === "album" ? data.title : null,
            thumbnail: null, duration: null, year: "year" in data ? data.year : null,
            artistId: "artistId" in data && data.artistId?.startsWith("ytmusic:") ? data.artistId.slice(8) : null,
          }
          const actions = youtubeMusicContext(type === "track" ? data as MusicTrack : item, navigate)
          showActions(keyboard ? bounds.left : e.clientX, keyboard ? bounds.bottom : e.clientY,
            { ...actions, actions: [...actions.actions, ...extraActions] })
          return
        }
        if (!provider) return
        show(keyboard ? bounds.left : e.clientX, keyboard ? bounds.bottom : e.clientY, type, data, playlistId, extraActions)
      },
    [show, showActions, provider, scope, navigate],
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
