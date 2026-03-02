const STORAGE_KEY = "plex-recent-playlist-ids"
const MAX_RECENT = 5

export function getRecentPlaylistIds(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as number[]
  } catch {
    return []
  }
}

export function recordRecentPlaylist(id: number): void {
  const ids = getRecentPlaylistIds().filter(i => i !== id)
  ids.unshift(id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)))
}
