import { newOccurrence, trackService, type MixedPlaylist, type Owners } from "./model"
import type { MusicTrack } from "../types/music"

export interface DraftMetadata {
  title: string
  description: string
  artwork: string | null
  external: NonNullable<MixedPlaylist["external"]>
}
export const defaultPlaylistSync = () => ({ listenbrainz: { enabled: false, automatic: true, direction: "export" as const } })
export function validateDraftMetadata(value: DraftMetadata): DraftMetadata {
  const title = value.title.trim()
  if (!title || title.length > 500) throw Error("Choose a playlist name of 1–500 characters.")
  if (value.description.length > 5000) throw Error("Keep the description under 5,000 characters.")
  if (value.artwork && (value.artwork.length > 3_000_000 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value.artwork)))
    throw Error("Choose a JPEG, PNG or WebP image under 2 MB.")
  if (!value.external || typeof value.external.listenbrainz?.enabled !== "boolean" ||
    typeof value.external.listenbrainz.automatic !== "boolean" || !["export", "import", "two-way"].includes(value.external.listenbrainz.direction))
    throw Error("Choose valid playlist sync settings.")
  return { ...structuredClone(value), title }
}
export function newDraft(metadata: DraftMetadata, id = `mixed:${crypto.randomUUID()}`, now = Date.now()): MixedPlaylist {
  const value = validateDraftMetadata(metadata)
  return { ...value, version: 1, revision: 0, id, local: true, owners: {}, aliases: [], providers: {}, items: [], createdAt: now,
    automatic: true, status: "ready", baseline: {}, baselineOrder: [], baselineTitle: value.title, admittedDrops: [],
    message: "Saved on this device. Add songs to connect this playlist to Plex or YouTube Music." }
}
/** Local retention is the admission boundary; no provider write belongs here. */
export function appendDraftSongs(playlist: MixedPlaylist, tracks: MusicTrack[], owners: Owners, admission: string): MixedPlaylist {
  if (playlist.admittedDrops.includes(admission)) return playlist
  if (!tracks.length || tracks.length > 1000) throw Error("Choose between 1 and 1,000 songs to add at once.")
  const bound = { ...playlist.owners }
  for (const track of tracks) {
    const service = trackService(track), owner = owners[service]
    if (bound[service] && owner && bound[service] !== owner) throw Error("Reconnect this playlist’s original account before adding its songs.")
    if (owner) bound[service] = owner
  }
  return { ...playlist, owners: bound, items: [...playlist.items, ...tracks.map(track => newOccurrence(track))],
    admittedDrops: [...playlist.admittedDrops, admission], message: "Songs saved in Hibiki. Provider sync will continue when the original accounts are connected." }
}
export function reviewUnappliedCreation(playlist: MixedPlaylist): MixedPlaylist {
  const receipt = playlist.write
  if (!receipt || receipt.kind !== "create" || receipt.destinationId || playlist.providers[receipt.service])
    throw Error("A known playlist must be recovered by its ID; its creation cannot be retried.")
  return { ...playlist, write: undefined, reviewedCreations: [...(playlist.reviewedCreations ?? []), { receipt, reviewedAt: Date.now() }].slice(-16),
    message: "Creation reviewed as not applied. A new attempt can continue." }
}
