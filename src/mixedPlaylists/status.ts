import { mixedWriteCanRecover, type MixedPlaylist } from "./model"

export function mixedSyncStatus(playlist: MixedPlaylist, running: boolean, queued: boolean, phase?: { kind: string; syncing?: boolean }) {
  const recovering = mixedWriteCanRecover(playlist)
  const review = !recovering && !!(playlist.write || playlist.detailsWrite || playlist.artworkWrite || playlist.listenbrainz?.creationPending || playlist.listenbrainz?.detailsWrite || playlist.status === "error" || playlist.status === "conflict")
  if (running) {
    const label = phase?.kind === "preparing" ? "Preparing" : phase?.kind === "matching" ? "Matching" : phase?.kind === "checking" ? "Checking" : phase?.kind === "details" ? "Saving details" : "Syncing"
    return { label, button: `${label}…`, busy: true, queued: false, review: false,
      title: phase?.kind === "matching" && phase.syncing ? "Matching songs and syncing verified songs" : `${label} this playlist` }
  }
  if (queued) return { label: "Queued", button: "Queued…", busy: true, queued: true, review: false, title: "Playlist sync is queued" }
  if (recovering) return { label: "Verification queued", button: "Sync", busy: false, queued: true, review: false,
    title: "Verify the last playlist change and resume sync" }
  if (review) return { label: "Sync paused", button: "Review sync", busy: false, queued: false, review: true,
    title: playlist.write ? "Playlist write is awaiting verification. Open sync details." : "Open playlist sync details" }
  return { label: "Sync", button: "Sync", busy: false, queued: false, review: false, title: "Match and sync this playlist" }
}
