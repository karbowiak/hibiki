import { useEffect, useRef } from "react"
import { useLocation } from "wouter"
import { useLinkedPlaylistStore } from "../../stores/linkedPlaylistStore"
import { useProviderStore } from "../../stores/providerStore"
import { useListenBrainzStore } from "../../metadata/listenbrainz/authStore"
import { useNotificationCenterStore } from "../../stores/notificationCenterStore"
import { providerPlaylistAccount } from "../../playlistSync/provider"
import { samePlaylistIdentity } from "../../playlistSync/types"
import { syncCreationAccounts } from "../../playlistSync/creation"
import {
  matchingResultNotice,
  claimMatchingNotice,
} from "../../playlistSync/matchingNotices"
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
        const creationOwner = syncCreationAccounts(intent)
        if (
          activeCreations[intent.id] ||
          !samePlaylistIdentity(creationOwner.library, account) ||
          creationOwner.listenbrainz.user !== username ||
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
              if (owns()) navigate("/collection/playlists")
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
        const input = matchingResultNotice(link, !!checkedErrors?.[link.id])
        if (!input) continue
        const id = input.id
        next.add(id)
        const notification = {
          ...input,
          action: {
            label: "Open playlist",
            run: () => {
              if (owns())
                navigate(
                  `/playlist/${encodeURIComponent(link.libraryPlaylistId)}`
                )
            },
          },
        }
        const currentResult = () => {
          if (!owns()) return false
          const state = useLinkedPlaylistStore.getState()
          const latest = state.links.find((item) => item.id === link.id)
          return (
            !!latest &&
            matchingResultNotice(latest, !!state.checkedErrors?.[link.id])
              ?.eventKey === input.eventKey
          )
        }
        const existing = useNotificationCenterStore
          .getState()
          .notifications.some(
            (entry) => entry.id === id && entry.eventKey === input.eventKey
          )
        if (input.severity === "warning" || existing)
          notices.notify(notification)
        if (input.severity !== "warning")
          void claimMatchingNotice(input.eventKey!, currentResult).then(
            (first) => {
              if (currentResult() && first && !existing)
                notices.notify(notification)
            }
          )
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
