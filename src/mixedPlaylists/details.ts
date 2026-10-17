import type { MusicProvider } from "../providers/types"
import type { MixedSyncOptions } from "./sync"
import { playlistServices, sameSequence, snapshotIds, type MixedPlaylist, type RemotePlaylist } from "./model"

const sameSongs = (a: RemotePlaylist, b: RemotePlaylist) => sameSequence(snapshotIds(a), snapshotIds(b)) &&
  sameSequence(a.items.map(row => row.occurrenceId), b.items.map(row => row.occurrenceId))
const detailsMatch = (page: RemotePlaylist, title: string, description: string) => page.title === title && (page.description ?? "") === description
async function imageDigest(image: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(image))), byte => byte.toString(16).padStart(2, "0")).join("")
}
/** Membership, descriptions and artwork have independent recoverable receipts. */
export async function syncDraftDetails(initial: MixedPlaylist, options: MixedSyncOptions & {
  provider?: MusicProvider | null; review?: boolean; settleOnly?: boolean
}) {
  let playlist = initial
  if (!playlist.local || (!playlist.items.length && !Object.keys(playlist.providers).length)) return playlist
  const owns = () => { if (!options.current()) throw Error("Music accounts changed. Playlist details remain saved in Hibiki.") }
  const save = async (next: MixedPlaylist) => { owns(); playlist = await options.save(next); owns() }
  if (playlist.detailsWrite) {
    const receipt = playlist.detailsWrite, adapter = options.adapters[receipt.service]
    if (!adapter || adapter.owner !== playlist.owners[receipt.service]) throw Error("Reconnect the original account to review playlist details.")
    const actual = await adapter.read(receipt.before.id); owns()
    if (!sameSongs(actual, receipt.before)) throw Error("Playlist songs changed during a details save. Review the service before retrying.")
    if (detailsMatch(actual, receipt.title, receipt.description))
      await save({ ...playlist, detailsWrite: undefined, baseline: { ...playlist.baseline, [receipt.service]: actual } })
    else if (options.review && detailsMatch(actual, receipt.before.title, receipt.before.description ?? ""))
      await save({ ...playlist, detailsWrite: undefined })
    else throw Error("Playlist details have an uncertain outcome. Review and retry the saved details before continuing.")
  }
  const provider = options.provider, plexId = playlist.providers.plex?.id
  if (playlist.artworkWrite) {
    if (!provider?.getArtworkInventory || provider.cacheScope !== playlist.owners.plex || !plexId || provider.isOffline)
      throw Error("Reconnect the original Plex library to review its playlist image.")
    const inventory = await provider.getArtworkInventory("playlist", plexId, "poster"); owns()
    if (!options.review) throw Error("The Plex image save needs review. Review its current image before accepting or retrying it.")
    // An explicit review accepts a changed remote image, or retries an unchanged
    // before-state. An automatic tick never repeats an uncertain upload.
    await save({ ...playlist, artworkSaved: inventory.baseline !== playlist.artworkWrite.baseline ? playlist.artworkWrite.digest : playlist.artworkSaved, artworkWrite: undefined })
  }
  if (options.settleOnly) return playlist
  for (const service of playlistServices(playlist)) {
    const adapter = options.adapters[service], ref = playlist.providers[service]
    if (!ref || !adapter?.describe) continue
    owns()
    const before = await adapter.read(ref.id); owns()
    if (before.readOnly) throw Error("Playlist details cannot be saved to a read-only destination.")
    const description = playlist.description ?? ""
    if (detailsMatch(before, playlist.title, description)) continue
    await save({ ...playlist, detailsWrite: { service, before, title: playlist.title, description } })
    await adapter.describe(before, playlist.title, description); owns()
    const actual = await adapter.read(ref.id); owns()
    if (!sameSongs(actual, before) || !detailsMatch(actual, playlist.title, description)) throw Error("The service did not confirm the playlist details. Review before retrying.")
    await save({ ...playlist, detailsWrite: undefined, baseline: { ...playlist.baseline, [service]: actual } })
  }
  if (playlist.artwork && plexId && provider?.getArtworkInventory && provider.saveArtwork && provider.cacheScope === playlist.owners.plex && !provider.isOffline) {
    const digest = await imageDigest(playlist.artwork); owns()
    if (playlist.artworkSaved !== digest) {
      const inventory = await provider.getArtworkInventory("playlist", plexId, "poster"); owns()
      await save({ ...playlist, artworkWrite: { baseline: inventory.baseline, digest } })
      const bytes = Array.from(atob(playlist.artwork.split(",")[1]), char => char.charCodeAt(0))
      await provider.saveArtwork("playlist", plexId, "poster", inventory.baseline, { upload: bytes }); owns()
      await save({ ...playlist, artworkWrite: undefined, artworkSaved: digest })
    }
  }
  return playlist
}
