import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useHeyaServiceStore } from "../metadata/services/store"
import {
  useMetadataIdentityStore,
  validIdentityCandidate,
} from "../stores/metadataIdentityStore"
import { resolveMetadataIdentity } from "../metadata/identity/resolve"
import { metadataIdentityItemKey } from "../stores/metadataIdentityStore"
import {
  heyaDiscoveryCapability,
  heyaDiscover,
  heyaDiscoveryStep,
  heyaDiscoveryForget,
  type DiscoveryCapability,
  type DiscoveryProgress,
} from "../metadata/discovery/api"
import { reviewHeyaIdentity } from "../metadata/identity/api"
import type { MetadataIdentity } from "../metadata/core/types"
import type { ReviewedMetadataIdentity } from "../metadata/identity/types"
export function useHeyaDiscovery(
  identity: MetadataIdentity,
  onReviewed: (review: ReviewedMetadataIdentity, lease: string) => boolean
) {
  const provider = useProviderStore((state) => state.provider),
    status = useHeyaServiceStore((state) => state.status)
  useMetadataIdentityStore((state) => state.choices)
  useMetadataIdentityStore((state) => state.versions)
  useMetadataIdentityStore((state) => state.hydrated)
  const lease = resolveMetadataIdentity(identity).lease,
    key = metadataIdentityItemKey(identity)
  const [availabilityRetry, setAvailabilityRetry] = useState(0)
  const [ownerEpoch, setOwnerEpoch] = useState(0)
  const owner = useMemo(
    () => ({
      provider,
      revision: status?.revision,
      connectionId: status?.connectionId,
      key,
      lease,
    }),
    [provider, status?.revision, status?.connectionId, key, lease, ownerEpoch]
  )
  const receipt = useRef<{
    revision: string
    scope: string
    handle: string
  } | null>(null)
  const forget = () => {
    const current = receipt.current
    receipt.current = null
    if (current)
      void heyaDiscoveryForget(
        current.revision,
        current.scope,
        current.handle
      ).catch(() => {})
  }
  const live = useRef(owner)
  live.current = owner
  const automaticChecks = useRef(0)
  const monotonicNow = () => performance.now()
  const generation = useRef(0),
    busy = useRef(false),
    deadline = useRef(0)
  const [state, setState] = useState<{
    owner: typeof owner
    capability: DiscoveryCapability | null
    progress: DiscoveryProgress | null
    loading: boolean
    error: string | null
    previewed: boolean
  }>({
    owner,
    capability: null,
    progress: null,
    loading: false,
    error: null,
    previewed: false,
  })
  const current = () =>
    live.current === owner &&
    useProviderStore.getState().provider === provider &&
    !provider?.isOffline &&
    provider?.cacheScope === identity.scope &&
    useHeyaServiceStore.getState().status?.revision === owner.revision &&
    resolveMetadataIdentity(identity).lease === lease
  useEffect(() => {
    const retire = () => {
      forget()
      generation.current++
      setOwnerEpoch((value) => value + 1)
      busy.current = false
      setState({
        owner: live.current,
        capability: null,
        progress: null,
        loading: false,
        error: null,
        previewed: false,
      })
    }
    const subscriptions = [
      useProviderStore.subscribe(retire),
      useMetadataIdentityStore.subscribe(retire),
      useHeyaServiceStore.subscribe((next, previous) => {
        if (next.status?.revision !== previous.status?.revision) retire()
      }),
    ]
    return () => {
      forget()
      subscriptions.forEach((unsubscribe) => unsubscribe())
      generation.current++
    }
  }, [])
  useEffect(() => {
    forget()
    generation.current++
    busy.current = false
    setState({
      owner,
      capability: null,
      progress: null,
      loading: false,
      error: null,
      previewed: false,
    })
    if (
      identity.kind === "track" ||
      !key ||
      !status?.enabled ||
      !status.configured ||
      !status.connectionId ||
      !current()
    )
      return
    const version = generation.current
    void heyaDiscoveryCapability(status.revision, identity.scope)
      .then((capability) => {
        if (version === generation.current && current())
          setState((previous) => ({ ...previous, owner, capability }))
      })
      .catch(() => {
        if (version === generation.current && current())
          setState((previous) => ({
            ...previous,
            capability: {
              available: false,
              reason:
                "Discovery availability could not be checked. Existing identity search remains available.",
            },
          }))
      })
  }, [owner, availabilityRetry])
  const progress = state.owner === owner ? state.progress : null
  const action = useCallback(
    async (operation: () => Promise<DiscoveryProgress>, newBudget = false) => {
      if (busy.current || !current() || !state.capability?.available) return
      busy.current = true
      const version = generation.current
      if (newBudget) {
        deadline.current = monotonicNow() + 60_000
        automaticChecks.current = 0
      }
      setState((previous) => ({
        ...previous,
        owner,
        loading: true,
        error: null,
        previewed: false,
      }))
      try {
        const result = await operation()
        if (version !== generation.current || !current()) {
          void heyaDiscoveryForget(
            owner.revision!,
            identity.scope,
            result.handle
          ).catch(() => {})
          return
        }
        receipt.current = {
          revision: owner.revision!,
          scope: identity.scope,
          handle: result.handle,
        }
        if (version === generation.current && current())
          setState((previous) => ({
            ...previous,
            progress: result,
            loading: false,
          }))
      } catch {
        if (version === generation.current && current()) {
          setState((previous) => ({
            ...previous,
            loading: false,
            error:
              "Discovery could not finish. Check status or search existing identities before starting another discovery.",
          }))
          // Auth denial is remembered natively for this revision; this read never
          // sends another discovery POST or prompts for credentials.
          void heyaDiscoveryCapability(status!.revision, identity.scope)
            .then((capability) => {
              if (version === generation.current && current())
                setState((previous) => ({ ...previous, capability }))
            })
            .catch(() => {})
        }
      } finally {
        if (version === generation.current) busy.current = false
      }
    },
    [owner, state.capability]
  )
  const start = (query: string) =>
    identity.kind !== "track" && query.trim()
      ? action(
          () =>
            heyaDiscover(
              status!.revision,
              identity.scope,
              identity.kind as "artist" | "album",
              query,
              resolveMetadataIdentity(identity).lookupArtist,
              identity.kind === "artist"
                ? resolveMetadataIdentity(identity).artistMbid
                : resolveMetadataIdentity(identity).releaseGroupMbid
            ),
          true
        )
      : Promise.resolve()
  const check = useCallback(
    () =>
      progress
        ? action(() =>
            heyaDiscoveryStep(status!.revision, identity.scope, progress.handle)
          )
        : Promise.resolve(),
    [action, progress, owner]
  )
  const select = (reference: string) =>
    progress?.candidates.some((candidate) => candidate.reference === reference)
      ? action(
          () =>
            heyaDiscoveryStep(
              status!.revision,
              identity.scope,
              progress.handle,
              reference
            ),
          true
        )
      : Promise.resolve()
  useEffect(() => {
    if (
      !progress ||
      state.loading ||
      state.error ||
      ["completed", "failed", "needs-selection"].includes(progress.state) ||
      monotonicNow() >= deadline.current ||
      automaticChecks.current >= 60
    )
      return
    const delay = Math.max(1000, Math.min(60_000, progress.retryAfter * 1000))
    if (monotonicNow() + delay > deadline.current) return
    const timer = setTimeout(() => {
      automaticChecks.current++
      void check()
    }, delay)
    return () => clearTimeout(timer)
  }, [progress, state.loading, state.error, check])
  const review = async () => {
    if (
      !progress?.canonicalId ||
      busy.current ||
      !current() ||
      identity.kind === "track"
    )
      return false
    busy.current = true
    const version = generation.current
    setState((previous) => ({ ...previous, loading: true, error: null }))
    try {
      const result = await reviewHeyaIdentity(
        status!.revision,
        identity.kind,
        progress.canonicalId
      )
      if (version !== generation.current || !current()) return false
      if (
        !validIdentityCandidate(result.candidate) ||
        result.candidate.id !== progress.canonicalId ||
        result.candidate.kind !== identity.kind ||
        result.candidate.connectionId !== owner.connectionId ||
        !onReviewed(result, lease)
      )
        throw Error("retired")
      setState((previous) => ({ ...previous, loading: false, previewed: true }))
      return true
    } catch {
      if (version === generation.current && current())
        setState((previous) => ({
          ...previous,
          loading: false,
          error:
            "This discovered identity could not be verified. Review an existing identity instead.",
        }))
      return false
    } finally {
      if (version === generation.current) busy.current = false
    }
  }
  const owned = state.owner === owner
  return {
    capability: owned ? state.capability : null,
    progress,
    loading: owned && state.loading,
    error: owned ? state.error : null,
    previewed: owned && state.previewed,
    retryAvailability: () => setAvailabilityRetry((value) => value + 1),
    start,
    check,
    select,
    review,
    offline: !!provider?.isOffline,
  }
}
