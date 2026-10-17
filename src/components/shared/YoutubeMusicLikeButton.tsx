import { useEffect } from "react"
import { IconHeart, IconLoader2 } from "@tabler/icons-react"
import type { MusicTrack } from "../../types/music"
import { isYoutubeMusicId } from "../../backends/ytmusic/tracks"
import { useYoutubeMusicLikesStore } from "../../backends/ytmusic/likes"
import { useOfflineStatusStore } from "../../offline/statusStore"
import { useNotificationCenterStore } from "../../stores/notificationCenterStore"
import { useAnnouncerStore } from "../../stores/announcerStore"

/** YTM hearts share one state across tables, the player, search and the queue. */
export function YoutubeMusicLikeButton({ track, eager = false, size = 16, onSaved }: {
  track: MusicTrack
  eager?: boolean
  size?: number
  onSaved?: () => void
}) {
  const entry = useYoutubeMusicLikesStore(state => state.entries[track.id])
  const owner = useYoutubeMusicLikesStore(state => state.owner)
  const offline = useOfflineStatusStore(state => state.offlineMode)
  const eligible = isYoutubeMusicId(track.id)
  const enabled = eligible && owner !== null && !offline
  const check = () => { if (enabled) void useYoutubeMusicLikesStore.getState().check(track) }
  useEffect(() => { if (eager && enabled) check() }, [eager, enabled, owner, track.id])
  if (!eligible) return null
  const busy = !!(entry?.checking || entry?.saving)
  const action = entry?.liked ? "Unlike" : "Like"
  const description = !enabled ? offline ? "Connect to the internet to change YTM likes" : "Connect YouTube Music to change likes"
    : entry?.error ? `${entry.error} Try again.`
    : entry?.liked === undefined ? "Check and change this song's like on YouTube Music" : `${action} on YouTube Music`
  const toggle = async () => {
    if (!enabled || useYoutubeMusicLikesStore.getState().owner !== owner) return
    const saved = await useYoutubeMusicLikesStore.getState().toggle(track)
    if (useYoutubeMusicLikesStore.getState().owner !== owner) return
    const latest = useYoutubeMusicLikesStore.getState().entries[track.id]
    const noticeId = `ytmusic.like.${track.id}`
    if (saved) {
      useNotificationCenterStore.getState().resolve(noticeId)
      useAnnouncerStore.getState().announce(`${track.title} ${latest?.liked ? "liked" : "unliked"} on YouTube Music.`)
      onSaved?.()
    } else if (latest?.error) {
      useNotificationCenterStore.getState().notify({ id: noticeId, title: "YouTube Music like failed", message: latest.error, severity: "error" })
    }
  }
  return <button
    type="button"
    disabled={!enabled || !!entry?.saving}
    aria-label={`${entry?.liked === undefined ? "Check like for" : action} ${track.title} on YouTube Music`}
    aria-pressed={entry?.liked}
    aria-busy={busy}
    title={description}
    onPointerEnter={check}
    onFocus={check}
    onPointerDown={event => event.stopPropagation()}
    onMouseDown={event => { event.stopPropagation(); event.preventDefault() }}
    onKeyDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); event.preventDefault(); void toggle() }}
    onDoubleClick={event => event.stopPropagation()}
    className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40 ${entry?.liked ? "text-accent hover:text-accent/80" : "text-(--text-secondary) hover:text-(--text-primary)"}`}
  >
    {busy ? <IconLoader2 size={size} stroke={1.7} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
      : <IconHeart size={size} stroke={1.7} fill={entry?.liked ? "currentColor" : "none"} aria-hidden="true" />}
  </button>
}
