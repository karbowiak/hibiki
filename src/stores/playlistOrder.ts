import { useSyncExternalStore } from "react"
import { createScalarPreference } from "./scalarPreference"

const order = createScalarPreference<string[]>("plex-sidebar-playlist-order", [], raw => {
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.some(id => typeof id !== "string")) throw Error("Invalid playlist order")
  return [...new Set(value)]
}, JSON.stringify)

export const usePlaylistOrder = () => useSyncExternalStore(order.subscribe, order.snapshot)
export function sortPlaylists<T extends { id: string }>(playlists: T[], ids: string[]) {
  const rank = new Map(ids.map((id, index) => [id, index]))
  return [...playlists].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
}
export function savePlaylistOrder(visibleIds: string[]) {
  const visible = new Set(visibleIds)
  const previous = order.snapshot()
  const remaining = [...visibleIds]
  // Keep disconnected service entries in place so reordering Plex alone does
  // not erase the listener's YTM positions (or the other way around).
  const next = previous.map(id => visible.has(id) ? remaining.shift()! : id)
  next.push(...remaining)
  order.set(next)
}
