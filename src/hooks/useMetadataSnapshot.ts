import { useMetadataIdentityStore } from "../stores/metadataIdentityStore"
import { resolveMetadataIdentity } from "../metadata/identity/resolve"
import { reviewedIdentityAdapters } from "../metadata/identity/adapters"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  metadataSelectionFor,
  useMetadataSelectionStore,
} from "../stores/metadataSelectionStore"
import {
  useFanartServiceStore,
  useHeyaServiceStore,
} from "../metadata/services/store"
import { useSoulSyncStore } from "../metadata/soulsync/store"
import { useTheAudioDbStore } from "../metadata/theaudiodb/store"
import { nativeSoulSyncAdapter } from "../metadata/soulsync/adapter"
import { useProviderStore } from "../stores/providerStore"
import { useMetadataSourceStore } from "../stores/metadataSourceStore"
import { useLastfmStore } from "../metadata/lastfm/authStore"
import { createMetadataClient } from "../metadata/core/client"
import { existingMetadataProviders } from "../metadata/core/existingProviders"
import { libraryMetadataSnapshot } from "../metadata/core/adapters"
import {
  metadataIdentityKey,
  resolveMetadataField,
} from "../metadata/core/resolve"
import type {
  MetadataAdapter,
  MetadataProviderSource,
  MetadataField,
  MetadataIdentity,
  MetadataResult,
  MetadataSelection,
  MetadataSnapshot,
} from "../metadata/core/types"
import type { MusicAlbum, MusicArtist, MusicTrack } from "../types/music"
/** Edit/enrichment snapshot consumer. Pass null while closed: no speculative I/O.
 * Library fields use the already-owned model; artwork rendering continues to use
 * existing image hooks for strict matching, failure fallback and revisions. */
const NO_ADDITIONAL_PROVIDERS: readonly MetadataAdapter[] = []
const NO_REQUIRED_SOURCES: readonly MetadataProviderSource[] = []
export function useMetadataSnapshot(
  identity: MetadataIdentity | null,
  libraryItem: MusicArtist | MusicAlbum | MusicTrack | null,
  suppliedSelection?: MetadataSelection,
  additionalProviders: readonly MetadataAdapter[] = NO_ADDITIONAL_PROVIDERS,
  requiredSources: readonly MetadataProviderSource[] = NO_REQUIRED_SOURCES
) {
  useMetadataIdentityStore((state) => state.choices)
  useMetadataIdentityStore((state) => state.versions)
  useMetadataIdentityStore((state) => state.hydrated)
  const reviewed = identity ? resolveMetadataIdentity(identity) : null
  const offline = useProviderStore((state) => state.provider?.isOffline)
  const choices = useMetadataSelectionStore((state) => state.choices)
  const selection =
    suppliedSelection ??
    (identity ? metadataSelectionFor(identity, choices) : undefined)
  const fanartStatus = useFanartServiceStore((state) => state.status)
  const heyaStatus = useHeyaServiceStore((state) => state.status)
  const audioDbStatus = useTheAudioDbStore((state) => state.status)
  useEffect(() => {
    void useFanartServiceStore.getState().load()
    void useHeyaServiceStore.getState().load()
    void useTheAudioDbStore.getState().load()
  }, [])
  const soulStatus = useSoulSyncStore((state) => state.status)
  const loadSoulSync = useSoulSyncStore((state) => state.load)
  useEffect(() => {
    void loadSoulSync()
  }, [loadSoulSync])
  const soulAdapter = useMemo(
    () =>
      nativeSoulSyncAdapter(
        soulStatus,
        () => useSoulSyncStore.getState().status
      ),
    [soulStatus?.revision]
  )
  const provider = useProviderStore((s) => s.provider)
  const scope = useProviderStore((s) => s.provider?.cacheScope)
  const priority = useMetadataSourceStore((s) => s.priority)
  const auth = useLastfmStore(
    useShallow((s) => ({ hasApiKey: s.hasApiKey, username: s.username }))
  )
  const [revision, setRevision] = useState(0)
  const client = useMemo(() => {
    const token = {}
    return createMetadataClient(
      reviewed
        ? reviewedIdentityAdapters(
            [
              ...existingMetadataProviders(),
              soulAdapter,
              ...additionalProviders,
            ],
            reviewed
          )
        : [...existingMetadataProviders(), soulAdapter, ...additionalProviders],
      () => {
        const current = useProviderStore.getState().provider,
          currentAuth = useLastfmStore.getState()
        return !current?.isOffline &&
          current === provider &&
          (!identity ||
            resolveMetadataIdentity(identity).lease === reviewed?.lease) &&
          current?.cacheScope === scope &&
          useFanartServiceStore.getState().status?.revision ===
            fanartStatus?.revision &&
          useHeyaServiceStore.getState().status?.revision ===
            heyaStatus?.revision &&
          useTheAudioDbStore.getState().status?.revision ===
            audioDbStatus?.revision &&
          currentAuth.hasApiKey === auth.hasApiKey &&
          currentAuth.username === auth.username &&
          scope
          ? { scope, token }
          : null
      }
    )
  }, [
    provider,
    scope,
    auth.hasApiKey,
    auth.username,
    soulAdapter,
    fanartStatus?.revision,
    heyaStatus?.revision,
    audioDbStatus?.revision,
    additionalProviders,
    reviewed?.lease,
  ])
  const key = identity ? metadataIdentityKey(identity) : null
  const requestScope = identity?.scope
  const sourceOrder = JSON.stringify(priority)
  const selectionKey = JSON.stringify(selection ?? null)
  const requiredKey = JSON.stringify(requiredSources)
  const requestedSources = useMemo(() => {
    const applicable =
      selection &&
      selection.scope === requestScope &&
      selection.identityKey === key
        ? selection
        : undefined
    return [
      ...new Set([
        ...priority,
        ...requiredSources,
        ...(applicable?.source ? [applicable.source] : []),
        ...Object.values(applicable?.fields ?? {}),
      ]),
    ].filter((source) => source !== "plex") as MetadataProviderSource[]
  }, [sourceOrder, selectionKey, requiredKey, key, requestScope])
  const [loaded, setLoaded] = useState<{
    key: string | null
    scope?: string
    client: typeof client
    results: Partial<Record<MetadataProviderSource, MetadataResult>>
  }>({ key: null, client, results: {} })
  useEffect(() => {
    // Observe actual transitions, including provider A -> B -> A before a render.
    const retire = () => client.retire()
    const unsubscribeProvider = useProviderStore.subscribe(retire)
    const unsubscribeIdentity = useMetadataIdentityStore.subscribe(retire)
    const unsubscribeAuth = useLastfmStore.subscribe(retire)
    const unsubscribeSoulSync = useSoulSyncStore.subscribe((next, previous) => {
      if (next.status?.revision !== previous.status?.revision) {
        client.retire()
        setRevision((value) => value + 1)
      }
    })
    const unsubscribeServices = [
      useFanartServiceStore,
      useHeyaServiceStore,
      useTheAudioDbStore,
    ].map((store) =>
      store.subscribe((next, previous) => {
        if (next.status?.revision !== previous.status?.revision) {
          client.retire()
          setRevision((value) => value + 1)
        }
      })
    )
    return () => {
      unsubscribeProvider()
      unsubscribeIdentity()
      unsubscribeAuth()
      unsubscribeSoulSync()
      unsubscribeServices.forEach((unsubscribe) => unsubscribe())
      client.retire()
    }
  }, [client])
  useEffect(() => {
    let active = true
    setLoaded({ key, scope: requestScope, client, results: {} })
    if (
      !identity ||
      !provider ||
      offline ||
      !reviewed?.ready ||
      requestScope !== scope
    )
      return
    for (const source of requestedSources) {
      void client.lookup(source, identity).then((result) => {
        if (!active) return
        setLoaded((previous) => ({
          ...previous,
          results: { ...previous.results, [source]: result },
        }))
      })
    }
    return () => {
      active = false
      client.retire()
    }
  }, [client, key, requestScope, requestedSources, revision, offline])
  const owned =
    !!identity &&
    !!provider &&
    requestScope === scope &&
    loaded.key === key &&
    loaded.scope === scope &&
    loaded.client === client
  const results = owned ? loaded.results : {}
  const snapshots: MetadataSnapshot[] = []
  if (identity && libraryItem && requestScope === scope) {
    const base = libraryMetadataSnapshot(identity, libraryItem)
    if (base.status === "ready") snapshots.push(base.snapshot)
  }
  for (const result of Object.values(results))
    if (result.status === "ready") snapshots.push(result.snapshot)
  const resolveField = <K extends MetadataField>(field: K) =>
    identity
      ? resolveMetadataField(field, identity, snapshots, priority, selection)
      : null
  const refresh = useCallback(
    (source: MetadataProviderSource) => {
      if (
        !identity ||
        identity.scope !== scope ||
        !client.invalidate(source, identity)
      )
        return false
      setRevision((value) => value + 1)
      return true
    },
    [client, key, requestScope, scope]
  )
  return {
    snapshots,
    requestedSources,
    results,
    sourceFields: (source: MetadataProviderSource) => {
      const result = results[source]
      return result?.status === "ready" ? result.snapshot.fields : null
    },
    resolveField,
    refresh,
    isLoading:
      !!reviewed?.ready &&
      !offline &&
      !!identity &&
      requestScope === scope &&
      requestedSources.some((source) => !results[source]),
  }
}
