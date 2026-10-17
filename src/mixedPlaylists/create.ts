import { useMixedPlaylistStore } from "../stores/mixedPlaylistStore"
import { useProviderStore } from "../stores/providerStore"
import { usePlayerStore } from "../stores/playerStore"
import { youtubeMusicSongMetadata } from "../backends/ytmusic/metadata"
import { captureMusicOwner } from "./counterparts"
import type { DraftMetadata } from "./drafts"
import type { MusicPlaylist, MusicTrack } from "../types/music"
import type { MixedPlaylist } from "./model"

export const draftPlaylistSummary = (playlist: MixedPlaylist): MusicPlaylist => ({
  id: playlist.id, title: playlist.title, smart: false, trackCount: playlist.items.length,
  duration: null, thumbUrl: playlist.artwork ?? null, summary: playlist.description ?? null,
  addedAt: new Date(playlist.createdAt).toISOString(), providerKey: "hibiki",
})
export async function selectedPlaylistTracks(ids: string[]): Promise<MusicTrack[]> {
  const owner = captureMusicOwner(), player = usePlayerStore.getState()
  const known = [player.currentTrack, ...player.queue].filter((track): track is MusicTrack => !!track)
  const tracks: MusicTrack[] = []
  for (const id of ids) {
    const cached = known.find(track => track.id === id && track.title && track.duration)
    const track = cached ?? (id.startsWith("ytmusic:") ? await youtubeMusicSongMetadata(id) : await useProviderStore.getState().provider?.getTrack(id))
    if (!owner.current()) throw Error("Music accounts changed. Add your selection again.")
    if (!track) throw Error("Reconnect to add the selected songs, or create an empty playlist.")
    tracks.push(track)
  }
  return tracks
}
export async function createLocalPlaylist(metadata: DraftMetadata, ids: string[] = [], id?: string) {
  const tracks = ids.length ? await selectedPlaylistTracks(ids) : []
  const playlist = await useMixedPlaylistStore.getState().createDraft(metadata, id)
  if (tracks.length) await useMixedPlaylistStore.getState().append(playlist.id, tracks, `create:${playlist.id}`)
  return draftPlaylistSummary(useMixedPlaylistStore.getState().playlists.find(item => item.id === playlist.id) ?? playlist)
}
