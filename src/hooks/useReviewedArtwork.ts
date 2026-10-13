import { useEffect, useState, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useProviderStore } from "../stores/providerStore"
import { useMetadataIdentityStore } from "../stores/metadataIdentityStore"
import { resolveMetadataIdentity } from "../metadata/identity/resolve"
import {
  useFanartServiceStore,
  useHeyaServiceStore,
} from "../metadata/services/store"
import {
  fanartGetArtist,
  fanartGetAlbum,
  type ProviderArtworkCandidate,
} from "../metadata/services/api"
import type { HeyaLookup } from "../metadata/heya/adapter"
import type { MetadataIdentity } from "../metadata/core/types"
interface Images {
  posters: ProviderArtworkCandidate[]
  backgrounds: ProviderArtworkCandidate[]
}
const cache = new Map<string, Images>(),
  pending = new Map<string, Promise<Images | null>>()
export function useReviewedArtwork(
  source: "fanart" | "heya" | "coverartarchive",
  identity: MetadataIdentity | null,
  allowFetch: boolean
) {
  useMetadataIdentityStore((state) => state.choices)
  useMetadataIdentityStore((state) => state.versions)
  useMetadataIdentityStore((state) => state.hydrated)
  const retired = useRef(0)
  const [epoch, setEpoch] = useState(0)
  useEffect(
    () =>
      useProviderStore.subscribe(() => {
        retired.current++
        setEpoch((value) => value + 1)
      }),
    []
  )
  const provider = useProviderStore((state) => state.provider),
    resolution = identity ? resolveMetadataIdentity(identity) : null
  const fanart = useFanartServiceStore((state) => state.status),
    heya = useHeyaServiceStore((state) => state.status)
  const status = source === "fanart" ? fanart : source === "heya" ? heya : null
  const key = JSON.stringify([
    source,
    identity?.scope,
    identity?.entityId,
    identity?.kind,
    resolution?.lease,
    status?.revision,
    epoch,
  ])
  const [loaded, setLoaded] = useState<{
    key: string
    data: Images | null
    pending: boolean
  } | null>(null)
  useEffect(() => {
    if (
      !identity ||
      !resolution?.choice ||
      identity.scope !== provider?.cacheScope
    )
      return
    const capturedEpoch = retired.current
    const current = () =>
      retired.current === capturedEpoch &&
      useProviderStore.getState().provider === provider &&
      resolveMetadataIdentity(identity).lease === resolution.lease &&
      (source === "coverartarchive" ||
        (source === "fanart"
          ? useFanartServiceStore
          : useHeyaServiceStore
        ).getState().status?.revision === status?.revision)
    const saved = cache.get(key)
    if (saved) {
      setLoaded({ key, data: saved, pending: false })
      return
    }
    if (
      !allowFetch ||
      provider.isOffline ||
      (source !== "coverartarchive" && (!status?.enabled || !status.configured))
    )
      return
    let active = true
    let job = pending.get(key)
    if (!job) {
      if (pending.size >= 16) return
      job = (async (): Promise<Images | null> => {
        if (source === "fanart") {
          if (identity.kind === "album" && resolution.releaseGroupMbid) {
            const item = await fanartGetAlbum(
              status!.revision,
              resolution.releaseGroupMbid,
              resolution.artistMbid
            )
            return item?.mbid === resolution.releaseGroupMbid &&
              item.revision === status!.revision
              ? item
              : null
          }
          if (!resolution.artistMbid) return null
          const item = await fanartGetArtist(
            status!.revision,
            resolution.artistMbid
          )
          if (
            !item ||
            item.mbid !== resolution.artistMbid ||
            item.revision !== status!.revision
          )
            return null
          return identity.kind === "artist"
            ? item
            : {
                posters:
                  item.albums.find(
                    (album) => album.mbid === resolution.releaseGroupMbid
                  )?.posters ?? [],
                backgrounds: [],
              }
        }
        if (source === "heya") {
          const mbid =
            identity.kind === "artist"
              ? resolution.artistMbid
              : resolution.releaseGroupMbid
          if (!resolution.heyaId && !mbid) return null
          const item = await invoke<HeyaLookup>("heya_get_metadata", {
            revision: status!.revision,
            kind: identity.kind,
            artist: identity.artist,
            title: identity.title ?? null,
            mbid: mbid ?? null,
            selectedId: resolution.heyaId ?? null,
            selectedConnectionId: resolution.connectionId ?? null,
          })
          if (
            item.status !== "ready" ||
            item.item.revision !== status!.revision ||
            (resolution.heyaId && item.item.id !== resolution.heyaId)
          )
            return null
          return item.item
        }
        if (identity.kind !== "album" || !resolution.releaseGroupMbid)
          return null
        const item = await invoke<{ cover_url: string } | null>(
          "coverartarchive_get_album",
          { releaseGroupMbid: resolution.releaseGroupMbid }
        )
        return item
          ? {
              posters: [
                {
                  id: resolution.releaseGroupMbid,
                  url: item.cover_url,
                  label: "Reviewed release-group cover",
                },
              ],
              backgrounds: [],
            }
          : null
      })()
        .then((data) => {
          if (data && current()) {
            cache.set(key, data)
            while (cache.size > 128) cache.delete(cache.keys().next().value!)
          }
          return data
        })
        .catch(() => null)
        .finally(() => pending.delete(key))
      pending.set(key, job)
    }
    setLoaded({ key, data: null, pending: true })
    void job.then((data) => {
      if (active && current()) setLoaded({ key, data, pending: false })
    })
    return () => {
      active = false
    }
  }, [key, allowFetch, provider])
  const owned =
    !!identity &&
    identity.scope === provider?.cacheScope &&
    !!resolution?.choice
  return {
    resolution,
    data: loaded?.key === key ? loaded.data : (cache.get(key) ?? null),
    pending: owned && loaded?.key === key && loaded.pending,
  }
}
