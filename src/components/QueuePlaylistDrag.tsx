import { Button } from "./shared/Button"
import { IconPlaylistAdd } from "@tabler/icons-react"
import { useTrackDrag } from "../hooks/useTrackDrag"
import type { MusicTrack } from "../types/music"

/** A separate copy handle leaves the queue's existing reorder gesture intact. */
export function QueuePlaylistDrag({ track }: { track: MusicTrack }) {
  const drag = useTrackDrag()
  return <Button variant="bare" type="button" aria-label={`Drag ${track.title} to a playlist`} title="Drag to a playlist"
    className="shrink-0 rounded p-1 text-(--text-muted) opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-(--text-primary) focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    onPointerDown={event => { event.stopPropagation(); drag.onPointerDown(event, { type: "track", ids: [track.id], tracks: [track], label: track.title }) }}
    onPointerMove={drag.onPointerMove} onPointerUp={drag.onPointerUp} onClick={event => event.stopPropagation()}>
    <IconPlaylistAdd size={16} aria-hidden="true" />
  </Button>
}
