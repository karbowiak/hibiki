import { get, update } from "idb-keyval"
import { playlistJournalDatabase } from "../playlistSync/journal"
import { sameOwners, type MixedPlaylist } from "./model"

const KEY = "mixed-playlists-v1"
export function retainMixedPlaylist(previous: MixedPlaylist[], playlist: MixedPlaylist, expected: number) {
  const old = previous.find(item => item.id === playlist.id)
  if ((old?.revision ?? 0) !== expected) throw Error("Playlist changed. Read its current contents and try again.")
  if (old && Object.entries(old.owners).some(([service, owner]) => playlist.owners[service as keyof typeof old.owners] !== owner))
    throw Error("A playlist cannot move between accounts.")
  if (previous.some(item => item.id !== playlist.id && (["plex", "ytmusic"] as const).some(service =>
    playlist.providers[service] && item.owners[service] === playlist.owners[service] && item.providers[service]?.id === playlist.providers[service]?.id)))
    throw Error("This provider playlist is already linked to another Hibiki playlist.")
  if (playlist.items.length > 10000 || new Set(playlist.items.map(row => row.id)).size !== playlist.items.length)
    throw Error("Invalid or oversized playlist.")
  if (old?.write && playlist.write && old.write.id !== playlist.write.id) throw Error("Resolve the previous playlist write first.")
  const saved = structuredClone({ ...playlist, revision: expected + 1 })
  return [...previous.filter(item => item.id !== playlist.id), saved]
}
export const mixedPlaylistRepository = {
  load: async (): Promise<MixedPlaylist[]> => (await get(KEY, playlistJournalDatabase())) ?? [],
  async save(playlist: MixedPlaylist, expected = playlist.revision): Promise<MixedPlaylist> {
    let saved: MixedPlaylist | undefined
    await update<MixedPlaylist[]>(KEY, previous => {
      const next = retainMixedPlaylist(previous ?? [], playlist, expected)
      saved = next.find(item => item.id === playlist.id)
      return next
    }, playlistJournalDatabase())
    if (!saved) throw Error("Unable to retain this playlist.")
    return saved
  },
  async find(owners: MixedPlaylist["owners"], alias: string) {
    return (await this.load()).find(item => sameOwners(item.owners, owners) && item.aliases.includes(alias))
  },
}
