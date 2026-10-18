import { Button } from "../../components/shared/Button"
import { useState } from "react"
import { useMusicBrainzMetadataStore } from "./store"
import { useMbidStore } from "./mbidStore"

export function MusicBrainzSettings() {
  const musicbrainzMetadata = useMusicBrainzMetadataStore()
  const stats = musicbrainzMetadata.stats()
  const mbidRecordings = useMbidStore(s => Object.keys(s.recordings).length)
  const clearMbidCache = useMbidStore(s => s.clearCache)
  const [clearing, setClearing] = useState(false)

  function handleClear() {
    setClearing(true)
    musicbrainzMetadata.clearCache()
    clearMbidCache()
    setTimeout(() => setClearing(false), 400)
  }

  const totalCount = stats.artistCount + stats.albumCount + mbidRecordings

  return (
    <div className="max-w-2xl">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-white/30 mb-4">Metadata Cache</h2>
      <p className="text-xs text-white/40 mb-4">
        MusicBrainz uses a public API — no authentication required. Data is cached locally with a 7–30 day TTL.
      </p>
      <div className="rounded-xl border border-white/10 bg-white/3 divide-y divide-white/5">
        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-sm text-white/60">Artists</span>
          <span className="text-sm font-medium text-white tabular-nums">{stats.artistCount}</span>
        </div>
        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-sm text-white/60">Albums</span>
          <span className="text-sm font-medium text-white tabular-nums">{stats.albumCount}</span>
        </div>
        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-sm text-white/60">Recording MBIDs</span>
          <span className="text-sm font-medium text-white tabular-nums">{mbidRecordings}</span>
        </div>
      </div>
      <Button
        variant="secondary"
        onClick={handleClear}
        disabled={clearing || totalCount === 0}
        className="mt-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs hover:border-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {clearing ? "Cleared" : "Clear Cache"}
      </Button>
    </div>
  )
}
