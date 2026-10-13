import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useProviderStore } from "../stores/providerStore"
import {
  useMetadataIdentityStore,
  metadataIdentityItemKey,
  identityChoiceFor,
  validIdentityCandidate,
} from "../stores/metadataIdentityStore"
import { useHeyaServiceStore } from "../metadata/services/store"
import {
  searchMusicBrainzIdentities,
  reviewMusicBrainzIdentity,
  searchHeyaIdentities,
  reviewHeyaIdentity,
} from "../metadata/identity/api"
import { resolveMetadataIdentity } from "../metadata/identity/resolve"
import type { MetadataIdentity } from "../metadata/core/types"
import type {
  IdentityProvider,
  MetadataIdentityCandidate,
  ReviewedMetadataIdentity,
} from "../metadata/identity/types"
/** Searches and detail reviews are explicit UI actions, never mount-time fetches. */
export function useMetadataIdentityChooser(identity: MetadataIdentity | null) {
  const provider = useProviderStore((state) => state.provider),
    choices = useMetadataIdentityStore((state) => state.choices),
    status = useHeyaServiceStore((state) => state.status)
  const key = identity ? metadataIdentityItemKey(identity) : null
  const lease = identity ? resolveMetadataIdentity(identity).lease : null
  const owner = useMemo(
    () => ({ provider, key, lease, revision: status?.revision }),
    [provider, key, lease, status?.revision]
  )
  const liveOwner = useRef(owner)
  liveOwner.current = owner
  const generation = useRef(0)
  const reviewedGeneration = useRef(-1)
  const [state, setState] = useState<{
    owner: typeof owner
    candidates: MetadataIdentityCandidate[]
    reviewed: ReviewedMetadataIdentity | null
    loading: boolean
    error: string | null
  }>({ owner, candidates: [], reviewed: null, loading: false, error: null })
  useEffect(() => {
    generation.current++
    setState({
      owner,
      candidates: [],
      reviewed: null,
      loading: false,
      error: null,
    })
  }, [owner])
  useEffect(() => {
    const retire = () => {
      generation.current++
      setState({
        owner: liveOwner.current,
        candidates: [],
        reviewed: null,
        loading: false,
        error: null,
      })
    }
    const unsubscribe = useProviderStore.subscribe(retire)
    const unsubscribeIdentity = useMetadataIdentityStore.subscribe(retire)
    const unsubscribeService = useHeyaServiceStore.subscribe(
      (next, previous) => {
        if (next.status?.revision !== previous.status?.revision) retire()
      }
    )
    return () => {
      unsubscribe()
      unsubscribeIdentity()
      unsubscribeService()
      generation.current++
    }
  }, [])
  const current = (version: number) =>
    !useProviderStore.getState().provider?.isOffline &&
    generation.current === version &&
    liveOwner.current === owner &&
    useProviderStore.getState().provider === provider &&
    !!identity &&
    identity.scope === provider?.cacheScope &&
    resolveMetadataIdentity(identity).lease === owner.lease &&
    useHeyaServiceStore.getState().status?.revision === owner.revision
  const search = useCallback(
    async (source: IdentityProvider, query?: string) => {
      if (
        provider?.isOffline ||
        !identity ||
        !key ||
        identity.kind === "track" ||
        identity.scope !== provider?.cacheScope
      )
        return
      const version = ++generation.current
      setState({
        owner,
        candidates: [],
        reviewed: null,
        loading: true,
        error: null,
      })
      try {
        if (
          source === "heya" &&
          (!status?.enabled || !status.configured || !status.connectionId)
        )
          throw Error("configuration")
        const items =
          source === "musicbrainz"
            ? await searchMusicBrainzIdentities(
                identity.kind,
                identity.artist,
                identity.title,
                query
              )
            : await searchHeyaIdentities(
                status!.revision,
                identity.kind,
                query?.trim() ||
                  (identity.kind === "artist"
                    ? identity.artist
                    : (identity.title ?? ""))
              )
        if (!current(version)) return
        const candidates = items
          .filter(
            (candidate) =>
              validIdentityCandidate(candidate) &&
              candidate.kind === identity.kind &&
              candidate.provider === source &&
              (source !== "heya" ||
                candidate.connectionId === status?.connectionId)
          )
          .slice(0, 20)
        setState({
          owner,
          candidates,
          reviewed: null,
          loading: false,
          error: null,
        })
      } catch {
        if (current(version))
          setState({
            owner,
            candidates: [],
            reviewed: null,
            loading: false,
            error:
              source === "heya" &&
              (!status?.enabled || !status.configured || !status.connectionId)
                ? "Configure HeyaMetadata in Settings before reviewing an identity."
                : "Could not search identities. Try again.",
          })
      }
    },
    [owner, identity, provider, status]
  )
  const review = useCallback(
    async (candidate: MetadataIdentityCandidate) => {
      if (
        provider?.isOffline ||
        !identity ||
        identity.kind === "track" ||
        !validIdentityCandidate(candidate) ||
        candidate.kind !== identity.kind ||
        !state.candidates.some(
          (c) => c.provider === candidate.provider && c.id === candidate.id
        )
      )
        return
      const version = ++generation.current
      setState((previous) => ({
        ...previous,
        owner,
        reviewed: null,
        loading: true,
        error: null,
      }))
      try {
        if (
          candidate.provider === "heya" &&
          candidate.connectionId !== status?.connectionId
        )
          throw Error("configuration")
        const result =
          candidate.provider === "musicbrainz"
            ? await reviewMusicBrainzIdentity(candidate.kind, candidate.id)
            : await reviewHeyaIdentity(
                status!.revision,
                candidate.kind,
                candidate.id
              )
        if (!current(version)) return
        if (
          !validIdentityCandidate(result.candidate) ||
          result.candidate.id !== candidate.id ||
          result.candidate.kind !== candidate.kind ||
          result.candidate.provider !== candidate.provider ||
          (candidate.provider === "heya" &&
            result.candidate.connectionId !== status?.connectionId) ||
          !Number.isFinite(result.reviewedAt) ||
          result.reviewedAt <= 0
        )
          throw Error("identity")
        reviewedGeneration.current = version
        setState((previous) => ({
          ...previous,
          owner,
          reviewed: result,
          loading: false,
          error: null,
        }))
      } catch {
        if (current(version))
          setState((previous) => ({
            ...previous,
            owner,
            reviewed: null,
            loading: false,
            error:
              "Could not verify this candidate’s exact identity. Try again.",
          }))
      }
    },
    [identity, owner, provider, state.candidates, status]
  )
  const adoptReviewed = useCallback(
    (review: ReviewedMetadataIdentity, capturedLease: string) => {
      if (
        !identity ||
        liveOwner.current !== owner ||
        resolveMetadataIdentity(identity).lease !== capturedLease ||
        capturedLease !== owner.lease ||
        useProviderStore.getState().provider !== provider ||
        provider?.isOffline ||
        provider?.cacheScope !== identity.scope ||
        !validIdentityCandidate(review.candidate) ||
        review.candidate.provider !== "heya" ||
        review.candidate.kind !== identity.kind ||
        review.candidate.connectionId !==
          useHeyaServiceStore.getState().status?.connectionId ||
        owner.revision !== useHeyaServiceStore.getState().status?.revision ||
        !Number.isFinite(review.reviewedAt) ||
        review.reviewedAt <= 0
      )
        return false
      reviewedGeneration.current = ++generation.current
      setState({
        owner,
        candidates: [review.candidate],
        reviewed: review,
        loading: false,
        error: null,
      })
      return true
    },
    [identity, owner, provider]
  )
  const apply = useCallback(() => {
    if (
      !identity ||
      reviewedGeneration.current !== generation.current ||
      liveOwner.current !== owner ||
      state.owner !== owner ||
      !state.reviewed ||
      state.loading ||
      identity.scope !== useProviderStore.getState().provider?.cacheScope ||
      resolveMetadataIdentity(identity).lease !== owner.lease ||
      useHeyaServiceStore.getState().status?.revision !== owner.revision
    )
      return false
    const accepted = useMetadataIdentityStore
      .getState()
      .setReviewed(identity, state.reviewed)
    if (!accepted)
      setState((previous) => ({
        ...previous,
        error:
          "This identity could not be saved. Reload the candidate and try again.",
      }))
    return accepted
  }, [identity, owner, state])
  const reset = useCallback(
    () =>
      !!identity &&
      identity.scope === useProviderStore.getState().provider?.cacheScope &&
      useMetadataIdentityStore.getState().reset(identity),
    [identity]
  )
  const owned = state.owner === owner
  return {
    candidates: owned ? state.candidates : [],
    reviewed: owned ? state.reviewed : null,
    selected: identity
      ? (identityChoiceFor(identity, choices)?.candidate ?? null)
      : null,
    loading: owned && state.loading,
    error: owned ? state.error : null,
    search,
    review,
    apply,
    adoptReviewed,
    reset,
    resolution: identity ? resolveMetadataIdentity(identity) : null,
    heyaAvailable:
      !!status?.enabled && status.configured && !!status.connectionId,
  }
}
