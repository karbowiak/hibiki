import { invoke } from "@tauri-apps/api/core"
import { freshPlaylistReads } from "../offline/providerCache"
import { youtubeMusicItemTrack, type YoutubeMusicItem } from "../backends/ytmusic/discovery"
import { captureMusicOwner } from "./counterparts"
import type { RemotePlaylist, Service } from "./model"
import type { SequenceOperation } from "../playlistSync/linked"

export interface MixedAdapter {
  service: Service
  owner: string
  read(id: string): Promise<RemotePlaylist>
  create(title: string): Promise<string>
  mutate(before: RemotePlaylist, operation: SequenceOperation): Promise<void>
}
export function mixedAdapters(capture = captureMusicOwner()): Partial<Record<Service, MixedAdapter>> {
  const { provider, owners, current } = capture
  const assert = () => { if (!current()) throw Error("Music account changed. Open the playlist again.") }
  const result: Partial<Record<Service, MixedAdapter>> = {}
  if (provider && owners.plex && !provider.isOffline) {
    const reads = freshPlaylistReads(provider)
    const read = async (id: string): Promise<RemotePlaylist> => {
      assert()
      const metadata = (await reads.getPlaylists()).find(item => item.id === id)
      assert()
      if (!metadata) throw Error("Plex playlist is no longer available.")
      const items: RemotePlaylist["items"] = [], handles = new Set<string>()
      let total: number | undefined
      do {
        const page = await reads.getPlaylistItems(id, items.length, 100)
        assert()
        if (!Number.isInteger(page.total) || page.total < 0 || page.total > 10000 ||
          (total !== undefined && total !== page.total) || (page.offset !== undefined && page.offset !== items.length) ||
          page.items.length > 100 || (!page.items.length && items.length < page.total)) throw Error("Plex playlist changed while reading. Try again.")
        total = page.total
        for (const track of page.items) {
          if (!track.playlistItemId || handles.has(track.playlistItemId)) throw Error("Plex did not return stable playlist occurrence IDs.")
          handles.add(track.playlistItemId)
          items.push({ occurrenceId: track.playlistItemId, track })
        }
        if (items.length > total) throw Error("Plex returned an inconsistent playlist.")
      } while (items.length < total)
      return { service: "plex", owner: owners.plex!, id, title: metadata.title, readOnly: metadata.smart, items }
    }
    result.plex = { service: "plex", owner: owners.plex,
      read, create: async title => { assert(); const created = await provider.createPlaylist(title, []); assert(); return created.id },
      mutate: async (before, operation) => {
        assert()
        if (before.readOnly || before.owner !== owners.plex || !provider.mutatePlaylistOccurrence) throw Error("This Plex playlist cannot be edited.")
        await provider.mutatePlaylistOccurrence(before.id, { title: before.title,
          items: before.items.map(item => ({ trackId: item.track.id, occurrenceId: item.occurrenceId })) }, operation)
        assert()
      } }
  }
  if (owners.ytmusic) {
    type NativeSnapshot = { id: string; title: string; readOnly: boolean; items: YoutubeMusicItem[]; handles: { videoId: string; occurrenceId: string }[] }
    const write = async (playlistId: string | null, expected: RemotePlaylist["items"], operation: object) => {
      assert()
      const id = await invoke<string>("ytmusic_playlist_write", { playlistId, expectedAccount: owners.ytmusic,
        expected: expected.map(item => ({ videoId: item.track.id.slice(8), occurrenceId: item.occurrenceId })), operation })
      assert()
      return id
    }
    result.ytmusic = { service: "ytmusic", owner: owners.ytmusic,
      read: async id => {
        assert()
        const snapshot = await invoke<NativeSnapshot>("ytmusic_playlist_read", { playlistId: id.replace(/^VL/, ""), expectedAccount: owners.ytmusic })
        assert()
        if (snapshot.items.length !== snapshot.handles.length) throw Error("Incomplete YouTube Music playlist.")
        return { service: "ytmusic", owner: owners.ytmusic!, id: `VL${snapshot.id}`, title: snapshot.title, readOnly: snapshot.readOnly,
          items: snapshot.items.map((item, index) => {
            if (snapshot.handles[index].videoId !== item.id) throw Error("YouTube Music occurrence identity changed.")
            return { occurrenceId: snapshot.handles[index].occurrenceId, track: youtubeMusicItemTrack(item) }
          }) }
      },
      create: async title => `VL${await write(null, [], { kind: "create", title })}`,
      mutate: async (before, operation) => {
        if (before.readOnly || before.owner !== owners.ytmusic) throw Error("This YouTube Music playlist is read-only.")
        await write(before.id.replace(/^VL/, ""), before.items,
          operation.kind === "append" ? { kind: "append", videoId: operation.trackId.slice(8) } : operation)
      } }
  }
  return result
}
