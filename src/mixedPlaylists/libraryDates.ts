import { songReference, type AddedDate, type MixedPlaylist, type Service } from "./model"

interface LibraryDate {
  observedAt: number
  native?: AddedDate
}
export type LibraryDates = Record<string, LibraryDate>
const key = (playlist: MixedPlaylist, service: Service, id: string) => JSON.stringify([service, playlist.owners[service], id])

/** Kept independently of occurrences, so removing and re-adding a song cannot
 * reset its library date. Each service/account retains its own native date. */
export function retainLibraryDates(playlist: MixedPlaylist, previous: LibraryDates) {
  const dates = { ...previous }
  for (const row of playlist.items) for (const service of ["plex", "ytmusic"] as const) {
    const before = row.songs[service]
    if (!before || !playlist.owners[service]) continue
    const reference = songReference(before.track, before)
    const id = key(playlist, service, reference.track.id), retained = dates[id]
    dates[id] = { observedAt: Math.min(reference.libraryObservedAt!, retained?.observedAt ?? Infinity),
      native: reference.libraryAdded?.provenance === "provider" ? reference.libraryAdded : retained?.native }
  }
  const items = playlist.items.map(row => {
    const songs = { ...row.songs }
    for (const service of ["plex", "ytmusic"] as const) {
      const reference = songs[service]
      if (!reference) continue
      const date = dates[key(playlist, service, reference.track.id)]
      if (date) songs[service] = { ...reference, libraryObservedAt: date.observedAt,
        libraryAdded: date.native ?? { at: date.observedAt, provenance: "observed" } }
    }
    return { ...row, songs }
  })
  return { playlist: { ...playlist, items }, dates }
}
