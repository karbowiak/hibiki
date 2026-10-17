import type { WindowedCollection } from "./windowedPages"

/** Mix services without flattening the primary provider's bounded page window. */
export function interleavePages<P, S, T>(primary: WindowedCollection<P>, secondary: S[],
  mapPrimary: (item: P) => T, mapSecondary: (item: S) => T): WindowedCollection<T> {
  const paired = Math.min(primary.total, secondary.length)
  const position = (index: number) => index < paired * 2
    ? { primary: index % 2 === 0, index: Math.floor(index / 2) }
    : { primary: primary.total > secondary.length, index: index - paired }
  return {
    total: primary.total + secondary.length, error: primary.error, loading: primary.loading,
    getItem: index => {
      const at = position(index)
      if (!at.primary) return secondary[at.index] ? mapSecondary(secondary[at.index]) : undefined
      const item = primary.getItem(at.index)
      return item === undefined ? undefined : mapPrimary(item)
    },
    ensureRange: (start, end) => {
      let first = Infinity, last = -1
      for (let index = start; index < end; index++) {
        const at = position(index)
        if (at.primary) { first = Math.min(first, at.index); last = Math.max(last, at.index) }
      }
      if (last >= 0) primary.ensureRange(first, last + 1)
    },
    retry: primary.retry,
  }
}
