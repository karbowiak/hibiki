import type { DiscoveryCursor, DiscoverySlice } from "../hooks/useDiscoveryFeed"

/** Retain only the loaded pages reachable through the current cursor chain. */
export function discoveryPages<T>(identify: (item: T) => string, preserveOccurrences = false) {
  const pages = new Map<DiscoveryCursor, DiscoverySlice<T>>()
  return {
    has: (cursor: DiscoveryCursor) => pages.has(cursor),
    set: (cursor: DiscoveryCursor, page: DiscoverySlice<T>) => { pages.set(cursor, page) },
    read: () => {
      if (!pages.has(null)) return null
      const items: T[] = [], seen = new Set<string>(), visited = new Set<DiscoveryCursor>()
      let cursor: DiscoveryCursor | undefined = null
      let title: string | undefined
      while (cursor !== undefined && pages.has(cursor) && !visited.has(cursor)) {
        visited.add(cursor)
        const page = pages.get(cursor)!
        if (!title) title = page.title
        for (const item of page.items) {
          const id = identify(item)
          if (preserveOccurrences || !seen.has(id)) { seen.add(id); items.push(item) }
        }
        // Filtering or duplicate suppression can empty any page. Only upstream
        // exhaustion or a repeated token ends the continuation chain.
        cursor = page.next
      }
      const invalid = cursor !== undefined && visited.has(cursor)
      if (invalid) cursor = undefined
      return { items, next: cursor, title, pageCount: visited.size, ...(invalid ? { invalid: true } : {}) }
    },
  }
}
