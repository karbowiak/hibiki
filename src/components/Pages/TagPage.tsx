import { PageRecovery } from "../shared/PageRecovery"
import { PageLoading } from "../shared/PageLoading"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import { usePlayerStore, useUIStore } from "../../stores"
import { useProviderStore } from "../../stores/providerStore"
import { useCapability } from "../../hooks/useCapability"
import { prefetchAlbum } from "../../stores/metadataCache"
import { MediaCard } from "../MediaCard"
import { MediaGrid } from "../shared/MediaGrid"
import type { MusicAlbum } from "../../types/music"

type TagType = "genre" | "mood" | "style"

const PAGE_SIZE = 100

function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === "auto" || overflowY === "scroll") return node
    node = node.parentElement
  }
  return null
}

export function TagPage({
  tagType,
  tagName,
}: {
  tagType: TagType
  tagName: string
}) {
  const [, navigate] = useLocation()
  const hasTags = useCapability("tags")
  const playFromUri = usePlayerStore((s) => s.playFromUri)

  const provider = useProviderStore((s) => s.provider)
  const pageRefreshKey = useUIStore((s) => s.pageRefreshKey)
  const [albums, setAlbums] = useState<MusicAlbum[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [retry, setRetry] = useState(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<{
    active: boolean
    pending: boolean
    offset: number
  } | null>(null)

  const resourceRef = useRef<{
    provider: typeof provider
    tagType: string
    tagName: string
  } | null>(null)

  useEffect(() => {
    if (!hasTags) navigate("/")
  }, [hasTags, navigate])

  useLayoutEffect(() => {
    const session = { active: true, pending: true, offset: 0 }
    sessionRef.current = session
    const current = () =>
      session.active && useProviderStore.getState().provider === provider
    const sameResource =
      resourceRef.current?.provider === provider &&
      resourceRef.current?.tagType === tagType &&
      resourceRef.current?.tagName === tagName
    resourceRef.current = { provider, tagType, tagName }
    if (!sameResource) {
      setAlbums([])
      setTotalCount(0)
    }
    setHasMore(false)
    setIsLoadingMore(false)
    setPageError(null)
    setError(null)
    setIsLoading(hasTags)
    if (!hasTags || !provider?.getItemsByTag) {
      setIsLoading(false)
      return () => {
        session.active = false
      }
    }
    void provider
      .getItemsByTag(tagType, tagName, "9", PAGE_SIZE, 0)
      .then(({ items, total }) => {
        if (!current()) return
        session.offset = items.length
        setAlbums(
          items.filter(
            (m): m is MusicAlbum & { type: "album" } => m.type === "album"
          )
        )
        setTotalCount(total)
        setHasMore(items.length > 0 && session.offset < total)
      })
      .catch((e) => {
        if (current()) setError(String(e))
      })
      .finally(() => {
        if (!current()) return
        session.pending = false
        setIsLoading(false)
      })
    return () => {
      session.active = false
    }
  }, [provider, hasTags, tagType, tagName, pageRefreshKey, retry])

  async function loadMore() {
    const session = sessionRef.current
    if (
      !session?.active ||
      session.pending ||
      !provider?.getItemsByTag ||
      !hasMore
    )
      return
    const current = () =>
      session.active && useProviderStore.getState().provider === provider
    session.pending = true
    setIsLoadingMore(true)
    setPageError(null)
    try {
      const { items, total } = await provider.getItemsByTag(
        tagType,
        tagName,
        "9",
        PAGE_SIZE,
        session.offset
      )
      if (!current()) return
      session.offset += items.length
      setAlbums((previous) => {
        const ids = new Set(previous.map((album) => album.id))
        const next = items.filter((m): m is MusicAlbum & { type: "album" } => {
          if (m.type !== "album" || ids.has(m.id)) return false
          ids.add(m.id)
          return true
        })
        return [...previous, ...next]
      })
      setTotalCount(total)
      setHasMore(items.length > 0 && session.offset < total)
    } catch (e) {
      if (current()) setPageError(String(e))
    } finally {
      if (current()) {
        session.pending = false
        setIsLoadingMore(false)
      }
    }
  }

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || isLoading || isLoadingMore || !hasMore || pageError) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore()
      },
      { root: findScrollContainer(sentinel), rootMargin: "200px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [provider, tagType, tagName, isLoading, isLoadingMore, hasMore, pageError])

  if (!hasTags) return null

  function handlePlayAll() {
    const provider = useProviderStore.getState().provider
    if (!provider?.buildTagFilterUri) return
    const uri = provider.buildTagFilterUri(tagType, tagName)
    void playFromUri(uri, true, tagName, null)
  }

  const isFullyLoaded = !hasMore

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center gap-4">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-gray-400">
            {tagType}
          </div>
          <h1 className="text-3xl font-bold">{tagName}</h1>
        </div>
        {albums.length > 0 && (
          <button
            onClick={handlePlayAll}
            title={`Shuffle all ${tagName} tracks`}
            className="flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-4 py-1.5 text-sm font-semibold text-accent transition-all hover:border-accent hover:bg-accent/20 active:scale-95"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
              <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
              <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
            </svg>
            Shuffle all
          </button>
        )}
      </div>

      {isLoading && albums.length === 0 && (
        <PageLoading message="Loading albums…" variant="shelves" />
      )}
      {error && (
        <PageRecovery
          title="Could not load albums."
          description="Your library may be temporarily unavailable. Try again when the connection is ready."
          onRetry={() => setRetry((value) => value + 1)}
          onOpenSettings={() => navigate("/settings")}
        />
      )}
      {!isLoading && !error && albums.length === 0 && (
        <div className="text-sm text-gray-400">
          No albums found for "{tagName}".
        </div>
      )}

      {albums.length > 0 && (
        <MediaGrid>
          {albums.map((album) => (
            <MediaCard
              key={album.id}
              contextItem={{ ...album, type: "album" }}
              title={album.title}
              desc={album.artistName}
              thumb={album.thumbUrl}
              href={`/album/${album.id}`}
              prefetch={() => prefetchAlbum(album.id)}
              dragPayload={{
                type: "album",
                ids: [album.id],
                label: album.title,
              }}
            />
          ))}
        </MediaGrid>
      )}

      {pageError && (
        <PageRecovery
          title="Could not load more albums."
          description="The albums already loaded are still available."
          onRetry={() => loadMore()}
        />
      )}
      {hasMore && (
        <button
          onClick={() => void loadMore()}
          disabled={isLoadingMore}
          className="mt-4 rounded-full border border-white/20 px-4 py-2 text-sm disabled:opacity-50"
        >
          {isLoadingMore
            ? "Loading more…"
            : pageError
              ? "Try loading more again"
              : "Load more albums"}
        </button>
      )}

      {/* Sentinel — always in DOM so IntersectionObserver can attach */}
      <div ref={sentinelRef} className="h-1" />

      {/* Footer status */}
      <div className="mt-4 flex items-center justify-center gap-2 text-xs text-gray-500">
        {isLoadingMore && (
          <svg
            className="animate-spin"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        )}
        {!isLoading &&
          totalCount > 0 &&
          (isFullyLoaded ? (
            <span>{albums.length} albums</span>
          ) : (
            <span>
              {albums.length} of {totalCount} albums
            </span>
          ))}
      </div>
    </div>
  )
}
