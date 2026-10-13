import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useMetadataIdentityStore } from "../stores/metadataIdentityStore"
import { resolveMetadataIdentity } from "../metadata/identity/resolve"
import { theAudioDb, useTheAudioDbStore } from "../metadata/theaudiodb/store"
import type { MetadataIdentity } from "../metadata/core/types"
import type { ArtworkRole } from "../stores/artworkPreferenceStore"
import type { ArtworkCandidate } from "../lib/artworkCandidates"
import { buildImageUrl } from "../lib/imageUrl"
const listeners = new Set<() => void>()
let providerEpoch = 0
useProviderStore.subscribe((next, old) => {
  if (
    next.provider !== old.provider ||
    next.provider?.cacheScope !== old.provider?.cacheScope
  ) {
    providerEpoch++
    for (const listener of listeners) listener()
  }
})
export function useTheAudioDbArtwork(
  kind: "artist" | "album",
  artist: string | null,
  title: string | null,
  entityId: string | null | undefined,
  role: ArtworkRole,
  scope: string | undefined,
  revise: (url: string | null) => string | null,
  allowFetch: boolean,
  originalIdentity?: MetadataIdentity
) {
  const epoch = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => providerEpoch,
    () => 0
  )
  const provider = useProviderStore((state) => state.provider)
  useMetadataIdentityStore((state) => state.choices)
  useMetadataIdentityStore((state) => state.versions)
  const hydrated = useMetadataIdentityStore((state) => state.hydrated)
  const { status, load, cacheVersion } = useTheAudioDbStore()
  const identity = useMemo(
    () =>
      originalIdentity ??
      (scope && artist
        ? {
            kind,
            artist,
            title: title ?? undefined,
            entityId: entityId ?? undefined,
            scope,
          }
        : null),
    [originalIdentity, scope, artist, title, kind, entityId]
  )
  const resolution = identity ? resolveMetadataIdentity(identity) : null
  const query = useMemo(
    () =>
      identity && resolution
        ? {
            ...identity,
            artist: resolution.lookupArtist,
            title: kind === "album" ? resolution.lookupTitle : undefined,
          }
        : null,
    [identity, resolution?.lease]
  )
  const mbid =
    kind === "artist" ? resolution?.artistMbid : resolution?.releaseGroupMbid
  const owner = useMemo(
    () => ({}),
    [epoch, provider, scope, resolution?.lease, status?.revision, hydrated]
  )
  const [pendingOwner, setPendingOwner] = useState<object | null>(null)
  const enabled =
    !!status?.enabled &&
    status.configured &&
    !!scope &&
    provider?.cacheScope === scope &&
    hydrated
  const cached = query && enabled ? theAudioDb.peek(query, mbid) : undefined
  useEffect(() => {
    if (!status && (allowFetch || provider?.isOffline)) void load()
    if (!enabled || !query || !allowFetch || provider?.isOffline || cached)
      return
    let active = true
    const capturedEpoch = epoch,
      capturedProvider = provider
    setPendingOwner(owner)
    void theAudioDb
      .lookup(query, mbid)
      .finally(() => {
        if (
          active &&
          providerEpoch === capturedEpoch &&
          useProviderStore.getState().provider === capturedProvider
        )
          setPendingOwner(null)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [
    owner,
    enabled,
    query,
    allowFetch,
    provider?.isOffline,
    cacheVersion,
    cached,
    load,
  ])
  const item =
    cached?.status === "ready" && cached.item.revision === status?.revision
      ? cached.item
      : null
  const raw = item
    ? role === "poster"
      ? item.posters
      : item.backgrounds.length
        ? item.backgrounds
        : item.posters.map((image) => ({
            ...image,
            label: `${image.label ?? "Cover"} reused as background`,
          }))
    : []
  const images: ArtworkCandidate[] = raw
    .filter((image) => {
      if (!image.id || image.id.length > 128) return false
      try {
        const url = new URL(image.url)
        return (
          url.protocol === "https:" &&
          [
            "www.theaudiodb.com",
            "theaudiodb.com",
            "r2.theaudiodb.com",
          ].includes(url.hostname) &&
          !url.username &&
          !url.password &&
          !url.port &&
          !url.search &&
          !url.hash
        )
      } catch {
        return false
      }
    })
    .slice(0, 12)
    .map((image) => ({
      ...image,
      provenance: `TheAudioDB · ${item!.url}`,
      url: revise(
        buildImageUrl(
          kind,
          entityId ?? item!.id,
          image.url,
          kind === "album" ? title : artist,
          kind === "album" ? artist : undefined,
          scope
        )
      )!,
    }))
  return {
    images,
    pending: enabled && !cached && pendingOwner === owner,
    revision: status?.revision,
  }
}
