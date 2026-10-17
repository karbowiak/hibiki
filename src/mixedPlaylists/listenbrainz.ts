import { invoke } from "@tauri-apps/api/core"
import { createLinkedSync, reconcileSyncCreation, syncCreationJournal } from "../playlistSync/creation"
import { checkLinkedPlaylist, reconcileLinkedStep, type LinkedSyncServices } from "../playlistSync/linkedExecution"
import { type LinkedTrackMapping, playlistContent, mapLinkedTracks } from "../playlistSync/linked"
import { nativeListenBrainzPlaylists, listenBrainzPlaylistAdapter, type ListenBrainzPlaylistTransport } from "../playlistSync/listenbrainz"
import { fromJspf } from "../playlistSync/jspf"
import { samePlaylistIdentity, type PlaylistAccount, type PlaylistSnapshot, type PlaylistTrack } from "../playlistSync/types"
import { recordingMbid } from "../playlistSync/matching"
import type { MusicProvider } from "../providers/types"
import type { MusicTrack } from "../types/music"
import type { MixedPlaylist, Owners } from "./model"
import { appendDraftSongs } from "./drafts"
import { itemArtistCredits } from "../lib/artistCredits"
import { recordingFingerprint, counterpartCandidates } from "./matching"
import { browseYoutubeMusic, youtubeMusicItemTrack, useYoutubeMusicDiscoveryStore } from "../backends/ytmusic/discovery"

const sourceAccount = (playlist: MixedPlaylist): PlaylistAccount => ({ service: "library:hibiki", user: playlist.id, revision: "1" })
const descriptor = (song: MusicTrack): PlaylistTrack => ({ id: song.id, title: song.title, artist: itemArtistCredits(song).map(credit => credit.name).join(", "), album: song.albumName, durationMs: song.duration })
export function draftListenBrainzSnapshot(playlist: MixedPlaylist): PlaylistSnapshot {
  return { id: playlist.id, account: sourceAccount(playlist), title: playlist.title, description: playlist.description ?? "",
    items: playlist.items.flatMap(row => {
      const song = row.songs[row.original]!.track, proof = playlist.listenbrainz?.proofs[song.id]
      return proof?.mbid && proof.fingerprint === recordingFingerprint(song) ? [{ occurrenceId: row.id, track: { ...descriptor(song), recordingMbid: proof.mbid } }] : []
    }) }
}
/** Projection edits cannot delete unmatched local occurrences. */
export function mutateDraftProjection(playlist: MixedPlaylist, before: PlaylistSnapshot, operation: import("../playlistSync/linked").SequenceOperation, owners: Owners = {}) {
  const actual = draftListenBrainzSnapshot(playlist)
  if (playlistContent(actual) !== playlistContent(before) || JSON.stringify(actual.items.map(row => row.occurrenceId)) !== JSON.stringify(before.items.map(row => row.occurrenceId)))
    throw Error("Hibiki playlist changed before the linked update.")
  const items = [...playlist.items]
  if (operation.kind === "append") {
    const row = items.find(row => row.songs[row.original]?.track.id === operation.trackId)
    const known = playlist.listenbrainz?.songs?.[operation.trackId] ?? row?.songs[row.original]?.track
    if (!known) throw Error("This recording has no verified playable song yet.")
    return appendDraftSongs(playlist, [known], owners, `listenbrainz:${crypto.randomUUID()}`)
  } else {
    const source = operation.kind === "delete" ? operation.index : operation.from
    const position = items.findIndex(row => row.id === before.items[source]?.occurrenceId)
    if (position < 0) throw Error("Playlist occurrence changed.")
    const [row] = items.splice(position, 1)
    if (operation.kind === "move") {
      const visible = before.items.filter((_, index) => index !== operation.from)
      const next = visible[operation.to]
      const target = next ? items.findIndex(row => row.id === next.occurrenceId) : items.length
      if (target < 0) throw Error("Playlist destination changed.")
      items.splice(target, 0, row)
    }
  }
  return { ...playlist, items }
}
async function recordingProof(song: MusicTrack, provider: MusicProvider | null | undefined, playlist: MixedPlaylist): Promise<string | null> {
  const local = playlist.items.find(row => row.songs[row.original]?.track.id === song.id)?.songs.plex?.track
  if (local && provider?.resolvePlaylistRecording && !provider.isOffline && provider.cacheScope === playlist.owners.plex) {
    const proof = await provider.resolvePlaylistRecording(descriptor(local))
    if (proof.status === "verified") return recordingMbid(proof.recordingMbid)
  }
  return invoke<string | null>("musicbrainz_playlist_recording", { source: { title: song.title, artists: itemArtistCredits(song).map(credit => credit.name), durationMs: song.duration } })
}
async function importedSong(row: PlaylistTrack, provider: MusicProvider | null | undefined): Promise<MusicTrack | null> {
  if (!row.recordingMbid || !row.durationMs || !row.title || !row.artist) return null
  const choices: MusicTrack[] = []
  if (provider?.findPlaylistCandidates && !provider.isOffline) {
    const page = await provider.findPlaylistCandidates(row)
    if (!page.truncated && !page.unavailable) choices.push(...page.tracks)
  }
  if (!choices.length && useYoutubeMusicDiscoveryStore.getState().connected) {
    const page = await browseYoutubeMusic({ browseId: "hibiki_song_search", params: `${row.artist} ${row.title}` })
    if (page.continuation) return null
    choices.push(...page.items.filter(item => item.kind === "song").map(youtubeMusicItemTrack))
  }
  if (!choices.length) return null
  const source = { ...choices[0], id: `listenbrainz:${row.recordingMbid}`, title: row.title, artistName: row.artist,
    artistCredits: undefined, artistId: null, albumName: row.album ?? "", duration: row.durationMs }
  const matches = counterpartCandidates(source, choices)
  if (matches.length !== 1) return null
  return await recordingProof(matches[0], null, { items: [] } as unknown as MixedPlaylist) === row.recordingMbid ? matches[0] : null
}
export async function syncDraftListenBrainz(initial: MixedPlaylist, options: {
  current(): boolean; save(playlist: MixedPlaylist): Promise<MixedPlaylist>; provider?: MusicProvider | null
  manual?: boolean; recoveryId?: string; prefer?: "hibiki" | "listenbrainz"; reviewNoCreation?: boolean
  transport?: ListenBrainzPlaylistTransport
  journal?: typeof syncCreationJournal
  resolveRecording?: (song: MusicTrack) => Promise<string | null>
  resolveImported?: (row: PlaylistTrack) => Promise<MusicTrack | null>
  owners?: Owners
}) {
  let playlist = initial
  const preference = playlist.external?.listenbrainz
  if (!playlist.local || !preference?.enabled || (!preference.automatic && !options.manual) || (!playlist.items.length && !playlist.listenbrainz?.link)) return playlist
  const transport = options.transport ?? nativeListenBrainzPlaylists, journal = options.journal ?? syncCreationJournal
  const owns = () => { if (!options.current()) throw Error("Playlist sync accounts changed.") }
  const save = async (next: MixedPlaylist) => { owns(); playlist = await options.save(next); owns(); return playlist }
  const retain = async (value: Partial<NonNullable<MixedPlaylist["listenbrainz"]>>) => save({ ...playlist, listenbrainz: { proofs: {}, ...playlist.listenbrainz, ...value } })
  const account = await transport.account(); owns()
  if (playlist.listenbrainz?.link && !samePlaylistIdentity(account, playlist.listenbrainz.link.listenbrainz)) throw Error("Reconnect this playlist’s original ListenBrainz account.")
  let budget = 5
  const songs = new Map(playlist.items.map(row => { const song = row.songs[row.original]!.track; return [song.id, song] }))
  for (const song of songs.values()) {
    const fingerprint = recordingFingerprint(song), old = playlist.listenbrainz?.proofs[song.id]
    if (old?.fingerprint === fingerprint && (!options.manual || old.mbid) && Date.now() - old.checkedAt < (old.mbid ? 86400000 : 300000)) continue
    if (!budget--) break
    const mbid = await (options.resolveRecording?.(song) ?? recordingProof(song, options.provider, playlist)); owns()
    await retain({ proofs: { ...playlist.listenbrainz?.proofs, [song.id]: { mbid: recordingMbid(mbid), fingerprint, checkedAt: Date.now() } },
      songs: { ...playlist.listenbrainz?.songs, [song.id]: song } })
  }
  const repository: LinkedSyncServices["repository"] = {
    load: async () => playlist.listenbrainz?.link ? [playlist.listenbrainz.link] : [],
    save: async (link, expected) => {
      if ((playlist.listenbrainz?.link?.revision ?? null) !== expected) throw Error("Linked playlist settings changed.")
      const next = { ...link, revision: (expected ?? 0) + 1 }
      await retain({ link: next }); return next
    },
  }
  const read = async () => { owns(); return draftListenBrainzSnapshot(playlist) }
  const source = { capabilities: { read: true, createCopy: false, replace: false }, account: async () => sourceAccount(playlist), read,
    createCopy: async () => { throw Error("Hibiki already owns this playlist.") } }
  const remoteReader = listenBrainzPlaylistAdapter(account, transport)
  const creation = { direction: "export" as const, source, target: remoteReader, journal, links: repository, current: options.current }
  if (!playlist.listenbrainz?.link) {
    if (!draftListenBrainzSnapshot(playlist).items.length) {
      await retain({ message: "Waiting for verified recording matches. Your songs remain in Hibiki." }); return playlist
    }
    const attempts = (await journal.load()).filter(intent => intent.sourceSnapshot.id === playlist.id && intent.sourceSnapshot.account.service === "library:hibiki" && intent.state !== "cancelled")
    owns()
    if (attempts.length > 1) throw Error("More than one ListenBrainz creation receipt needs review.")
    try {
    if (attempts[0]) {
      let intent = attempts[0]
      if (!samePlaylistIdentity(intent.target, account)) throw Error("Reconnect the original ListenBrainz account to review this creation.")
      if (!intent.destinationId && options.manual && options.reviewNoCreation) {
        await journal.save({ ...intent, state: "cancelled" })
        await createLinkedSync(playlist.id, playlist.title, creation)
      } else {
      if (!intent.destinationId && options.manual && options.recoveryId) { intent = { ...intent, destinationId: options.recoveryId, state: "created" }; await journal.save(intent) }
      await reconcileSyncCreation(intent, creation)
      }
    } else await createLinkedSync(playlist.id, playlist.title, creation)
    await retain({ creationPending: false })
    } catch (failure) {
      if (options.current() && (await journal.load()).some(intent => intent.sourceSnapshot.id === playlist.id && !["cancelled", "linked"].includes(intent.state)))
        await retain({ creationPending: true })
      throw failure
    }
  }
  let link = playlist.listenbrainz!.link!
  const remote = await remoteReader.read(link.listenbrainzPlaylistId); owns()
  const mappings: LinkedTrackMapping[] = draftListenBrainzSnapshot(playlist).items.map(row => ({ libraryTrack: row.track, recordingMbid: row.track.recordingMbid!, verifiedBy: "provider-mbid" }))
  const knownSongs = { ...playlist.listenbrainz?.songs }
  // Reuse prior verified imports even while their local occurrence is absent.
  for (const mapping of link.mappings) if (knownSongs[mapping.libraryTrack.id] && !mappings.some(row => row.libraryTrack.id === mapping.libraryTrack.id)) mappings.push(mapping)
  for (const row of remote.items) {
    if (preference.direction === "export" || mappings.some(mapping => mapping.recordingMbid === row.track.recordingMbid) || budget-- <= 0) continue
    const song = await (options.resolveImported?.(row.track) ?? importedSong(row.track, options.provider)); owns()
    if (!song || !row.track.recordingMbid) continue
    knownSongs[song.id] = song
    mappings.push({ libraryTrack: { ...descriptor(song), recordingMbid: row.track.recordingMbid }, recordingMbid: row.track.recordingMbid, verifiedBy: "metadata" })
    await retain({ songs: knownSongs, proofs: { ...playlist.listenbrainz?.proofs, [song.id]: { mbid: row.track.recordingMbid, fingerprint: recordingFingerprint(song), checkedAt: Date.now() } } })
  }
  const services: LinkedSyncServices = { repository, current: options.current,
    library: { account: source.account, read, mutate: async (before, operation) => {
      await save(mutateDraftProjection(playlist, before, operation, options.owners)); return read()
    } },
    listenbrainz: { account: () => transport.account(), read: id => remoteReader.read(id), mutate: async (before, operation, lease) => {
      owns()
      if (!transport.mutate || !samePlaylistIdentity(lease, account)) throw Error("ListenBrainz connection changed.")
      const actual = await transport.mutate(account, before.id, { title: before.title, mbids: before.items.map(row => row.track.recordingMbid!) }, operation)
      owns(); return fromJspf(actual, account)
    } },
  }
  link = { ...link, mappings, direction: preference.direction === "two-way" ? "bidirectional" : preference.direction, automatic: preference.automatic }
  if (!playlist.listenbrainz?.seeded && !link.job) {
    if (remote.items.length) throw Error("The new ListenBrainz playlist changed before its first sync. Review its contents before continuing.")
    const local = await read(), desired = mapLinkedTracks("library", local, mappings)
    if (desired.missing.length) throw Error("The first ListenBrainz copy needs recording matches.")
    link = { ...link, paused: false, state: "ready", job: { id: crypto.randomUUID(), source: "library", sourceSnapshot: local,
      destinationSnapshot: remote, desired: desired.desired, completedSteps: 0 } }
  }
  if (options.manual && link.job?.step) link = await reconcileLinkedStep(link, services, true)
  if (options.prefer) {
    if (link.job?.step) throw Error("Review the pending ListenBrainz write first.")
    const local = await read()
    const side = options.prefer === "hibiki" ? "library" : "listenbrainz"
    const selected = side === "library" ? local : remote, destination = side === "library" ? remote : local
    const mapped = mapLinkedTracks(side, selected, mappings)
    if (mapped.missing.length) throw Error("Some recordings still need verified matches before this order can be applied.")
    link = { ...link, paused: false, state: "ready", job: { id: crypto.randomUUID(), source: side,
      sourceSnapshot: selected, destinationSnapshot: destination, desired: mapped.desired, completedSteps: 0 } }
  } else if (link.state !== "conflict" && link.state !== "unknown" || options.manual && link.job && !link.job.step) link = { ...link, paused: false, pauseReason: undefined, state: "ready" }
  link = await repository.save(link, playlist.listenbrainz!.link!.revision)
  if (playlist.listenbrainz?.detailsWrite) {
    const receipt = playlist.listenbrainz.detailsWrite
    const complete = remote.title === receipt.title && (remote.description ?? "") === receipt.description
    const unchanged = playlistContent(remote) === playlistContent(receipt.before) && (remote.description ?? "") === (receipt.before.description ?? "")
    if (!complete && !(options.manual && unchanged)) throw Error("ListenBrainz details need review on the service before retrying.")
    await retain({ detailsWrite: undefined, link: { ...link, baseline: { ...link.baseline, listenbrainz: remote } } })
    link = playlist.listenbrainz!.link!
  }
  link = await checkLinkedPlaylist(link, services, 10)
  if (!link.job && link.state === "ready") await retain({ seeded: true })
  if (!link.job && link.state === "ready" && transport.describe && (remote.title !== playlist.title || (remote.description ?? "") !== (playlist.description ?? ""))) {
    const before = await remoteReader.read(remote.id); owns()
    await retain({ detailsWrite: { before, title: playlist.title, description: playlist.description ?? "" } })
    const actual = fromJspf(await transport.describe(account, before, playlist.title, playlist.description ?? ""), account); owns()
    await retain({ detailsWrite: undefined, link: { ...playlist.listenbrainz!.link!, baseline: { ...playlist.listenbrainz!.link!.baseline, listenbrainz: actual } } })
  }
  const missing = playlist.items.length - draftListenBrainzSnapshot(playlist).items.length
  await retain({ message: [missing ? `${missing} songs awaiting verified recording IDs; retained in Hibiki.` : "", playlist.listenbrainz?.link?.message ?? "ListenBrainz is up to date."].filter(Boolean).join(" ") })
  return playlist
}
