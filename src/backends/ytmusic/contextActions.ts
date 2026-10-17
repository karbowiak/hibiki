import { openUrl } from "@tauri-apps/plugin-opener"
import type { MusicTrack } from "../../types/music"
import type { ContextActionsData, ContextAction } from "../../stores/contextMenuStore"
import { usePlayerStore, capturePlaybackSelectionVersion } from "../../stores/playerStore"
import { captureMusicLinkOwner, musicEntityActions, trackEntity } from "../../lib/musicLinks"
import { youtubeMusicCollectionSource, youtubeMusicItemTrack, youtubeMusicItemHref, useYoutubeMusicDiscoveryStore, type YoutubeMusicItem } from "./discovery"
import { youtubeMusicLikeAction } from "./likes"
import { useOfflineStatusStore } from "../../offline/statusStore"

/** Every YTM surface supplies the same ordered, grouped context menu. */
export function youtubeMusicContext(data: YoutubeMusicItem | MusicTrack, navigate: (href: string) => void): ContextActionsData {
  const song = "kind" in data ? data.kind === "song" ? youtubeMusicItemTrack(data) : null : data
  const item: YoutubeMusicItem = "kind" in data ? data : {
    id: data.id.slice(8), kind: "song", title: data.title, artist: data.artistName, album: data.albumName,
    thumbnail: null, duration: null, year: data.year, artistId: data.artistId?.startsWith("ytmusic:") ? data.artistId.slice(8) : null,
    albumId: data.albumId?.startsWith("ytmusic:") ? data.albumId.slice(8) : null,
  }
  const owner = captureMusicLinkOwner()
  const available = () => owner() && useYoutubeMusicDiscoveryStore.getState().connected && !useOfflineStatusStore.getState().offlineMode
  const actions: ContextAction[] = []
  const action = (label: string, icon: ContextAction["icon"], section: ContextAction["section"],
    run: (current: () => boolean) => void | Promise<void>) => actions.push({ label, icon, section, disabled: !available(),
      run: async (menu = () => true) => {
        const current = () => available() && menu()
        if (!current()) throw Error("Reconnect YouTube Music and open this menu again.")
        await run(current)
      } })
  const source = () => youtubeMusicCollectionSource({ browseId: item.id })
  const readTracks = async (firstOnly: boolean, current: () => boolean) => {
    let collection = source()
    if (collection.prepare) collection = await collection.prepare() ?? collection
    const tracks: MusicTrack[] = []
    for (let offset = 0; offset < 500 && current(); offset += 50) {
      const page = await collection.loadPage(offset, firstOnly ? 1 : 50)
      if (!current()) throw Error("This menu is no longer active.")
      tracks.push(...page.items)
      if (firstOnly || !page.items.length || offset + page.items.length >= page.total) return tracks
    }
    throw Error("This collection is too large to insert at once. Use Play to listen to its full queue.")
  }
  const play = async (shuffle = false) => {
    const player = usePlayerStore.getState()
    if (song) await player.playTrack(song)
    else await player.playPagedTracks(source(), item.title, youtubeMusicItemHref(item), shuffle)
    if (usePlayerStore.getState().playerError) throw Error(usePlayerStore.getState().playerError!)
  }
  action(item.kind === "album" ? "Play album" : item.kind === "artist" ? "Play artist" : "Play", "play", "playback", () => play())
  if (item.kind === "playlist") action("Play shuffled", "shuffle", "playback", () => play(true))
  if (item.kind !== "playlist") {
    for (const next of [true, false]) action(next ? "Play next" : "Add to bottom", next ? "next" : "queue", "playback", async current => {
      const selection = capturePlaybackSelectionVersion()
      const owns = () => current() && selection === capturePlaybackSelectionVersion()
      const tracks = song ? [song] : await readTracks(false, owns)
      if (!owns()) return
      if (!tracks.length) throw Error("This collection has no playable songs.")
      if (next) usePlayerStore.getState().addNext(tracks)
      else usePlayerStore.getState().addToQueue(tracks)
    })
  }
  action("Start radio", "radio", "playback", async current => {
    const selection = capturePlaybackSelectionVersion()
    const owns = () => current() && selection === capturePlaybackSelectionVersion()
    const seed = song ?? (await readTracks(true, owns))[0]
    if (!owns()) return
    if (!seed) throw Error("This collection has no songs to start radio from.")
    await usePlayerStore.getState().playRadio(seed.id, "track", item.title, "ytmusic", seed)
    if (usePlayerStore.getState().playerError) throw Error(usePlayerStore.getState().playerError!)
  })
  if (song) actions.push({ ...youtubeMusicLikeAction(song), icon: "heart", section: "rating", disabled: !available() })
  const share = (label: string, url: string) => actions.push({ label, icon: "share", section: "share",
    run: () => { if (owner()) return openUrl(url) } })
  const external = song ? `https://music.youtube.com/watch?v=${encodeURIComponent(item.id)}`
    : item.id.startsWith("VL") ? `https://music.youtube.com/playlist?list=${encodeURIComponent(item.id.slice(2))}`
    : `https://music.youtube.com/browse/${encodeURIComponent(item.id)}`
  share("YouTube Music", external)
  const artist = item.kind === "artist" ? item.title : item.artist
  if (artist) share("Last.fm artist", `https://www.last.fm/music/${encodeURIComponent(artist)}`)
  if (item.kind === "album" && artist) share("Last.fm album", `https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(item.title)}`)
  if (song || item.kind === "album") {
    const refs = song ? [trackEntity(song, "artist"), trackEntity(song, "album")]
      : [{ kind: "artist" as const, name: item.artist, id: item.artistId ? `ytmusic:${item.artistId}` : null }]
    actions.push(...musicEntityActions(refs.filter(ref => ref?.name || ref?.id), navigate))
  }
  return { title: item.title, owner: data, actions }
}
