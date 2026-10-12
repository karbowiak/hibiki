import { eligibleAmbientUrl } from "../lib/ambientArtwork"
import { createStore } from "zustand/vanilla"
import type { MusicProvider } from "../providers/types"
import { useProviderStore } from "./providerStore"
export interface AmbientArtwork {
  src: string
  position: string
  align?: {
    heroW: number
    heroH: number
    heroTop: number
    heroLeft: number
    scrollTop: number
  }
  owner: string
  origin: "detail" | "pool"
  route: string
  scope?: string
  onFailure?: (src: string) => void
}
export type AmbientArtworkClaim = Omit<
  AmbientArtwork,
  "owner" | "origin" | "scope" | "position"
> & { position?: string }
interface Context {
  provider: MusicProvider | null
  scope?: string
}
interface OwnedClaim {
  lease: symbol
  provider: MusicProvider
  scope: string
  artwork: AmbientArtwork
}
function sameArtwork(a: AmbientArtwork | null, b: AmbientArtwork | null) {
  if (!a || !b) return a === b
  if (a.src !== b.src || a.route !== b.route || a.position !== b.position)
    return false
  if (!a.align || !b.align) return a.align === b.align
  return (
    ["heroW", "heroH", "heroTop", "heroLeft", "scrollTop"] as const
  ).every((key) => a.align![key] === b.align![key])
}
export function createAmbientArtworkController(getContext: () => Context) {
  let context = getContext()
  const owners = new Map<
    symbol,
    {
      owner: string
      provider: MusicProvider
      scope: string
      artwork: AmbientArtwork | null
    }
  >()
  const store = createStore<{ claims: OwnedClaim[]; failed: string[] }>(() => ({
    claims: [],
    failed: [],
  }))
  const publish = () =>
    store.setState({
      claims: [...owners].flatMap(([lease, claim]) =>
        claim.artwork
          ? [
              {
                lease,
                provider: claim.provider,
                scope: claim.scope,
                artwork: claim.artwork,
              },
            ]
          : []
      ),
    })
  const syncContext = () => {
    const next = getContext()
    if (next.provider !== context.provider || next.scope !== context.scope) {
      context = next
      owners.clear()
      store.setState({ claims: [], failed: [] })
    }
  }
  const current = (provider: MusicProvider, scope: string) => {
    const next = getContext()
    return next.provider === provider && next.scope === scope
  }
  function acquire(
    owner: string,
    provider: MusicProvider | null,
    scope?: string
  ) {
    syncContext()
    const lease = Symbol(owner)
    if (provider && scope && current(provider, scope)) {
      owners.set(lease, { owner, provider, scope, artwork: null })
      while (owners.size > 8) owners.delete(owners.keys().next().value!)
    }
    return {
      update: (claim: AmbientArtworkClaim | null) => {
        const entry = owners.get(lease)
        if (!entry || !current(entry.provider, entry.scope)) return
        const artwork =
          claim?.src && eligibleAmbientUrl(claim.src, entry.scope)
            ? {
                ...claim,
                position: claim.position ?? "50% 50%",
                align:
                  claim.align &&
                  Object.values(claim.align).every(Number.isFinite)
                    ? { ...claim.align }
                    : undefined,
                owner,
                origin: "detail" as const,
                scope: entry.scope,
              }
            : null
        if (sameArtwork(entry.artwork, artwork)) {
          if (entry.artwork) entry.artwork.onFailure = artwork?.onFailure
          return
        }
        entry.artwork = artwork
        publish()
      },
      release: () => {
        if (owners.delete(lease)) publish()
      },
    }
  }
  const getWinner = (
    route: string,
    provider: MusicProvider | null,
    scope?: string
  ): AmbientArtwork | null => {
    if (!provider || !scope || !current(provider, scope)) return null
    const state = store.getState()
    return (
      state.claims.findLast(
        (claim) =>
          claim.provider === provider &&
          claim.scope === scope &&
          claim.artwork.route === route &&
          !state.failed.includes(claim.artwork.src)
      )?.artwork ?? null
    )
  }
  const fail = (
    src: string,
    provider: MusicProvider | null,
    scope?: string
  ) => {
    if (!provider || !scope || !current(provider, scope)) return
    const failed = store.getState().failed
    if (!failed.includes(src))
      store.setState({ failed: [...failed.slice(-63), src] })
  }
  const failCurrent = (
    src: string,
    route: string,
    provider: MusicProvider | null,
    scope?: string
  ) => {
    const winner = getWinner(route, provider, scope)
    if (!winner || winner.src !== src) return false
    fail(src, provider, scope)
    try {
      winner.onFailure?.(src)
    } catch {
      /* Keep the safe fallback even if a consumer callback fails. */
    }
    return true
  }
  return { store, acquire, getWinner, fail, failCurrent, syncContext }
}
export const ambientArtworkController = createAmbientArtworkController(() => {
  const provider = useProviderStore.getState().provider
  return { provider, scope: provider?.cacheScope ?? undefined }
})
useProviderStore.subscribe(() => ambientArtworkController.syncContext())
