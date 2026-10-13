import { useEffect } from "react"
import { useProviderStore } from "../stores/providerStore"
import { useListenBrainzStore } from "../metadata/listenbrainz/authStore"
import { useLinkedPlaylistStore } from "../stores/linkedPlaylistStore"
import { providerPlaylistAccount } from "../playlistSync/provider"
import { samePlaylistIdentity } from "../playlistSync/types"
import {
  canAdvancePartialWeekly,
  linkedAutomaticSync,
} from "../playlistSync/linked"
/** Explicit links only; no auto-linking, no whole-library scan, no overlapping ticks. */
export function useLinkedPlaylistSync() {
  const provider = useProviderStore((s) => s.provider),
    authenticated = useListenBrainzStore((s) => s.isAuthenticated),
    username = useListenBrainzStore((s) => s.username)
  const error = useLinkedPlaylistStore((s) => s.error)
  useEffect(() => {
    if (
      !provider ||
      provider.isOffline ||
      !provider.mutatePlaylistOccurrence ||
      !authenticated ||
      error
    )
      return
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined
    const scope = provider.cacheScope,
      session = provider.playbackSession
    const current = () =>
      active &&
      useProviderStore.getState().provider === provider &&
      provider.cacheScope === scope &&
      provider.playbackSession === session &&
      !provider.isOffline &&
      useListenBrainzStore.getState().isAuthenticated &&
      useListenBrainzStore.getState().username === username &&
      !useLinkedPlaylistStore.getState().error &&
      navigator.onLine !== false
    async function tick() {
      try {
        await useLinkedPlaylistStore.getState().load()
        if (!current()) return
        const account = providerPlaylistAccount(provider!)
        let budget = 20
        for (const link of useLinkedPlaylistStore.getState().links) {
          if (!current()) break
          if (
            !link.enabled ||
            (!linkedAutomaticSync(link) &&
              !(link.incomplete && !link.incomplete.matchingDone)) ||
            (link.paused && !canAdvancePartialWeekly(link)) ||
            useLinkedPlaylistStore.getState().holds[link.id] ||
            useLinkedPlaylistStore.getState().running[link.id] ||
            !samePlaylistIdentity(link.library, account) ||
            link.listenbrainz.user !== username
          )
            continue
          try {
            if (link.incomplete && !link.incomplete.matchingDone) {
              void useLinkedPlaylistStore
                .getState()
                .matchIncomplete(link.id)
                .catch(() => {})
              continue
            }
            await useLinkedPlaylistStore.getState().syncNow(link.id, current, {
              maxSteps: Math.max(0, budget),
              automatic: true,
              onMutation: () => {
                budget--
              },
            })
          } catch {
            if (current())
              useLinkedPlaylistStore
                .getState()
                .checkError(
                  link.id,
                  "Could not check this linked playlist. Read checks will retry when the connection is available."
                )
          }
        }
      } catch {
        /* Local retention errors already stop writes; read availability retries are bounded. */
      } finally {
        if (active) timer = setTimeout(tick, 120000)
      }
    }
    void tick()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [
    provider,
    provider?.cacheScope,
    provider?.playbackSession,
    authenticated,
    username,
    error,
  ])
}
