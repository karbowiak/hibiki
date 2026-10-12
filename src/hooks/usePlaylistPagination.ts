import { useEffect, type RefObject } from "react"

/** Filtering loaded rows must not turn the sentinel into an automatic full-list drain. */
export function usePlaylistPagination({
  playlistId,
  scrollContainer,
  sentinel,
  isLoading,
  isFetchingMore,
  isFullyLoaded,
  filterQuery,
  blocked,
  onLoadMore,
}: {
  playlistId: string
  scrollContainer: RefObject<HTMLDivElement | null> | null
  sentinel: RefObject<HTMLDivElement | null>
  isLoading: boolean
  isFetchingMore: boolean
  isFullyLoaded: boolean
  filterQuery: string
  blocked: boolean
  onLoadMore: () => void
}) {
  useEffect(() => {
    if (isLoading || isFetchingMore || isFullyLoaded || filterQuery || blocked)
      return
    const container = scrollContainer?.current
    if (!container) return
    let active = true
    function check() {
      if (!active || !sentinel.current) return
      if (
        sentinel.current.getBoundingClientRect().top <=
        container!.getBoundingClientRect().bottom + 400
      )
        onLoadMore()
    }
    container.addEventListener("scroll", check, { passive: true })
    check()
    return () => {
      active = false
      container.removeEventListener("scroll", check)
    }
  }, [
    playlistId,
    scrollContainer,
    sentinel,
    isLoading,
    isFetchingMore,
    isFullyLoaded,
    filterQuery,
    blocked,
    onLoadMore,
  ])
}
