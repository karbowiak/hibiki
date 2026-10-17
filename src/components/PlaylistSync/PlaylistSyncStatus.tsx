import { useEffect, useRef } from "react"
import { useLocation } from "wouter"
import { useLinkedPlaylistStore } from "../../stores/linkedPlaylistStore"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { useNotificationCenterStore } from "../../stores/notificationCenterStore"
import { providerPlaylistAccount } from "../../playlistSync/provider"
import { samePlaylistIdentity } from "../../playlistSync/types"
import { syncCreationAccounts } from "../../playlistSync/creation"
import { useCopyOwner } from "./useCopyOwner"
/** Interrupt only when a creation receipt has not been retained locally. */
export function PlaylistSyncStatus() {
  const [, navigate] = useLocation()
  const provider = useProviderStore((s) => s.provider)
  const capture = useCopyOwner(provider, "sync-notices")
  const username = useListenBrainzStore((s) => s.username)
  const authenticated = useListenBrainzStore((s) => s.isAuthenticated)
  const intents = useLinkedPlaylistStore((s) => s.creationIntents)
  const unretained = useLinkedPlaylistStore((s) => s.unretainedCreations)
  const activeCreations = useLinkedPlaylistStore((s) => s.activeCreationIds)
  const published = useRef(new Set<string>())
  useEffect(() => {
    if (provider?.cacheScope && authenticated)
      void useLinkedPlaylistStore
        .getState()
        .loadCreationIntents()
        .catch(() => {})
  }, [provider, provider?.cacheScope, username, authenticated])
  useEffect(() => {
    const notices = useNotificationCenterStore.getState()
    const next = new Set<string>()
    const owns = capture()
    if (provider?.cacheScope && authenticated) {
      const account = providerPlaylistAccount(provider)
      for (const intent of intents) {
        const creationOwner = syncCreationAccounts(intent)
        if (
          activeCreations[intent.id] ||
          !unretained[intent.id] ||
          !samePlaylistIdentity(creationOwner.library, account) ||
          creationOwner.listenbrainz.user !== username
        )
          continue
        const id = `playlist.creation.${intent.id}`
        next.add(id)
        notices.notify({
          id,
          title: "Playlist sync recovery could not be saved",
          message: "The creation receipt is not saved. Recover it before any further sync writes; do not create a duplicate.",
          severity: "warning",
          persistent: true,
          action: {
            label: "Open playlist sync",
            run: () => {
              if (owns()) navigate("/collection/playlists")
            },
          },
        })
      }
    }
    for (const id of published.current) if (!next.has(id)) notices.resolve(id)
    published.current = next
  }, [
    provider,
    provider?.cacheScope,
    provider?.playbackSession,
    username,
    authenticated,
    intents,
    unretained,
    activeCreations,
    navigate,
    capture,
  ])
  useEffect(
    () => () => {
      for (const id of published.current)
        useNotificationCenterStore.getState().resolve(id)
    },
    []
  )
  return null
}
