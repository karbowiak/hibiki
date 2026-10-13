import { useEffect, useRef } from "react"
import { useLocation } from "wouter"
import { useLinkedPlaylistStore } from "../../stores/linkedPlaylistStore"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { useNotificationCenterStore } from "../../stores/notificationCenterStore"
import { providerPlaylistAccount } from "../../playlistSync/provider"
import { samePlaylistIdentity } from "../../playlistSync/types"
import { useCopyOwner } from "./useCopyOwner"
/** Session presentation of durable, account-owned sync receipts and matching progress. */
export function PlaylistSyncStatus() {
  const [, navigate] = useLocation()
  const provider = useProviderStore((s) => s.provider)
  const capture = useCopyOwner(provider, "sync-notices")
  const username = useListenBrainzStore((s) => s.username)
  const authenticated = useListenBrainzStore((s) => s.isAuthenticated)
  const intents = useLinkedPlaylistStore((s) => s.creationIntents)
  const unretained = useLinkedPlaylistStore((s) => s.unretainedCreations)
  const activeCreations = useLinkedPlaylistStore((s) => s.activeCreationIds)
  const links = useLinkedPlaylistStore((s) => s.links)
  const checkedErrors = useLinkedPlaylistStore((s) => s.checkedErrors)
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
        if (
          activeCreations[intent.id] ||
          !samePlaylistIdentity(intent.target, account) ||
          intent.sourceSnapshot.account.user !== username ||
          ((intent.state === "linked" || intent.state === "cancelled") &&
            !unretained[intent.id])
        )
          continue
        const id = `playlist.creation.${intent.id}`
        next.add(id)
        notices.notify({
          id,
          title: "Playlist creation needs recovery",
          message: unretained[intent.id]
            ? "The creation receipt is not saved. Recover it before any further sync writes; do not create a duplicate."
            : "Inspect the retained creation in Playlists → Sync before requesting another playlist.",
          severity: "warning",
          persistent: true,
          action: {
            label: "Open playlist sync",
            run: () => {
              if (owns()) navigate("/playlists")
            },
          },
        })
      }
      for (const link of links) {
        if (
          !samePlaylistIdentity(link.library, account) ||
          link.listenbrainz.user !== username ||
          !link.incomplete
        )
          continue
        const id = `playlist.matching.${link.id}`,
          progress = link.incomplete
        const missing = progress.missingOccurrenceIds.length
        const blocked =
          link.paused ||
          !link.enabled ||
          link.state === "error" ||
          link.state === "conflict" ||
          !!checkedErrors?.[link.id]
        if (progress.matchingDone && !missing && !blocked) continue
        next.add(id)
        notices.notify({
          id,
          title: blocked
            ? "Playlist matching paused"
            : progress.matchingDone
              ? "Playlist songs need review"
              : "Matching playlist songs",
          message: blocked
            ? "Matching is paused. Open this playlist's Sync review to retry lookups or inspect a retained update. Every source song is still retained."
            : progress.matchingDone
              ? `${missing} ${missing === 1 ? "song needs" : "songs need"} a choice. Every unresolved song remains in the playlist's Sync review.`
              : `${progress.matchedCount} of ${progress.total} songs matched. You can browse while matching continues.`,
          severity: blocked || progress.matchingDone ? "warning" : "info",
          persistent: true,
          action: {
            label: "Open playlist",
            run: () => {
              if (owns())
                navigate(
                  `/playlist/${encodeURIComponent(link.libraryPlaylistId)}`
                )
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
    links,
    checkedErrors,
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
