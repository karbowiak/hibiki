import type { MixedPlaylist } from "./model"

/** Provider writes may need review, but catalog matching only enriches local
 * rows. Keep finding counterparts without replaying an uncertain mutation. */
export async function syncAndMatchPlaylist(initial: MixedPlaylist, options: {
  sync(playlist: MixedPlaylist): Promise<MixedPlaylist>
  match(playlist: MixedPlaylist): Promise<MixedPlaylist>
  reload(): Promise<MixedPlaylist>
  current(): boolean
}) {
  let playlist = initial, failed: { error: unknown } | undefined
  try { playlist = await options.sync(playlist) }
  catch (error) {
    if (!options.current()) throw error
    failed = { error }
    playlist = await options.reload()
  }
  if (!options.current()) return playlist
  const before = playlist
  playlist = await options.match(playlist)
  if (failed) throw failed.error
  if (!options.current() || playlist.write || playlist.status === "conflict") return playlist
  return playlist === before ? playlist : options.sync(playlist)
}
