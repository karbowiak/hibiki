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
  /** Complete read-only merge source, including unavailable placeholders. */
  readSource?(id: string): Promise<RemotePlaylist>
  create(title: string): Promise<string>
  mutate(before: RemotePlaylist, operation: SequenceOperation): Promise<void>
  /** One preflighted append and one exact post-read for an ordered batch. */
  appendMany?(before: RemotePlaylist, trackIds: string[]): Promise<void>
  describe?(before: RemotePlaylist, title: string, description: string): Promise<void>
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
      return { service: "plex", owner: owners.plex!, id, title: metadata.title, description: metadata.summary ?? "", readOnly: metadata.smart, items }
    }
    result.plex = { service: "plex", owner: owners.plex,
      read, create: async title => { assert(); const created = await provider.createPlaylist(title, []); assert(); return created.id },
      describe: async (before, title, description) => {
        const actual = await read(before.id)
        assert()
        if (actual.readOnly || actual.title !== before.title || actual.description !== before.description ||
          JSON.stringify(actual.items.map(row => [row.occurrenceId, row.track.id])) !== JSON.stringify(before.items.map(row => [row.occurrenceId, row.track.id])))
          throw Error("The Plex playlist changed before saving its details. Refresh and review it.")
        await provider.editPlaylist(before.id, title, description)
        assert()
      },
      mutate: async (before, operation) => {
        assert()
        if (before.readOnly || before.owner !== owners.plex || !provider.mutatePlaylistOccurrence) throw Error("This Plex playlist cannot be edited.")
        await provider.mutatePlaylistOccurrence(before.id, { title: before.title,
          items: before.items.map(item => ({ trackId: item.track.id, occurrenceId: item.occurrenceId })) }, operation)
        assert()
      },
      appendMany: async (before, trackIds) => {
        assert()
        if (before.readOnly || before.owner !== owners.plex || !provider.mutatePlaylistOccurrence) throw Error("This Plex playlist cannot be edited.")
        await provider.mutatePlaylistOccurrence(before.id, { title: before.title,
          items: before.items.map(item => ({ trackId: item.track.id, occurrenceId: item.occurrenceId })) }, { kind: "appendMany", trackIds })
        assert()
      } }
  }
  if (owners.ytmusic) {
    type NativeSnapshot = { id: string; title: string; description: string; readOnly: boolean; items: YoutubeMusicItem[]; handles: { videoId: string; occurrenceId: string }[] }
    const write = async (playlistId: string | null, expected: RemotePlaylist["items"], operation: object) => {
      assert()
      const id = await invoke<string>("ytmusic_playlist_write", { playlistId, expectedAccount: owners.ytmusic,
        expected: expected.map(item => ({ videoId: item.track.id.slice(8), occurrenceId: item.occurrenceId })), operation })
      assert()
      return id
    }
    const read = async (id: string, sourceOnly = false): Promise<RemotePlaylist> => {
        assert()
        const snapshot = await invoke<NativeSnapshot>("ytmusic_playlist_read", { playlistId: id.replace(/^VL/, ""), expectedAccount: owners.ytmusic, sourceOnly })
        assert()
        if (snapshot.items.length !== snapshot.handles.length) throw Error("Incomplete YouTube Music playlist.")
        return { service: "ytmusic", owner: owners.ytmusic!, id: `VL${snapshot.id}`, title: snapshot.title, description: snapshot.description, readOnly: snapshot.readOnly,
          items: snapshot.items.map((item, index) => {
            if (snapshot.handles[index].videoId !== item.id) throw Error("YouTube Music occurrence identity changed.")
            return { occurrenceId: snapshot.handles[index].occurrenceId, track: youtubeMusicItemTrack(item), unavailable: item.unavailable }
          }) }
      }
    result.ytmusic = { service: "ytmusic", owner: owners.ytmusic,
      read, readSource: id => read(id, true),
      create: async title => `VL${await write(null, [], { kind: "create", title })}`,
      describe: async (before, title, description) => {
        await write(before.id.replace(/^VL/, ""), before.items, { kind: "metadata", title, description,
          expectedTitle: before.title, expectedDescription: before.description ?? "" })
      },
      mutate: async (before, operation) => {
        if (before.readOnly || before.owner !== owners.ytmusic) throw Error("This YouTube Music playlist is read-only.")
        await write(before.id.replace(/^VL/, ""), before.items,
          operation.kind === "append" ? { kind: "append", videoId: operation.trackId.slice(8) } : operation)
      },
      appendMany: async (before, trackIds) => {
        if (before.readOnly || before.owner !== owners.ytmusic) throw Error("This YouTube Music playlist is read-only.")
        await write(before.id.replace(/^VL/, ""), before.items, { kind: "appendMany", videoIds: trackIds.map(id => id.slice(8)) })
      } }
  }
  return result
}
