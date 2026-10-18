import { sqliteLocalStorage } from "../storage/clientStorage"
const STORAGE_KEY = "plex-recent-searches"
const MAX_RECENT = 10

function readRecentSearches(): string[] | null {
  try {
    const raw = sqliteLocalStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const saved: unknown = JSON.parse(raw)
    return Array.isArray(saved) &&
      saved.every((query) => typeof query === "string" && !!query.trim())
      ? saved
      : null
  } catch {
    return null
  }
}

export function getRecentSearches(): string[] {
  return (readRecentSearches() ?? []).slice(0, MAX_RECENT)
}

export function recordRecentSearch(query: string): void {
  const q = query.trim()
  if (!q) return
  const saved = readRecentSearches()
  // A failed/malformed read must not replace an existing history with defaults.
  if (saved === null) return
  const existing = saved.filter(
    (value) => value.toLowerCase() !== q.toLowerCase()
  )
  existing.unshift(q)
  sqliteLocalStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(existing.slice(0, MAX_RECENT))
  )
}

export function clearRecentSearches(): boolean {
  try {
    sqliteLocalStorage.removeItem(STORAGE_KEY)
    return true
  } catch {
    return false
  }
}
