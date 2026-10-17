import { useEffect, useState } from "react"
import { useProviderOwner } from "../hooks/useProviderOwner"
import { useProviderStore } from "../stores/providerStore"
import { useLibraryStore } from "../stores/libraryStore"
import { useUIStore } from "../stores/uiStore"
import type { MusicProvider } from "../providers/types"

type Info = Awaited<ReturnType<NonNullable<MusicProvider["getLibraryCacheInfo"]>>>

export function LibraryCacheControls() {
  const { provider, scope, session } = useProviderOwner()
  const [info, setInfo] = useState<Info | null>(null)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState("")
  const owns = () => provider === useProviderStore.getState().provider && provider?.cacheScope === scope && provider?.playbackSession === session
  useEffect(() => {
    let active = true
    setInfo(null); setError(""); setClearing(false)
    void provider?.getLibraryCacheInfo?.().then(value => {
      if (active && owns()) setInfo(value)
    }).catch(() => { if (active && owns()) setError("Could not read the library cache.") })
    return () => { active = false }
  }, [provider, scope, session])

  async function clear() {
    if (!provider?.clearLibraryCache) return
    setClearing(true); setError("")
    try {
      await provider.clearLibraryCache()
      if (!owns()) return
      useLibraryStore.getState().invalidateCache()
      useUIStore.getState().incrementPageRefreshKey()
      const value = await provider.getLibraryCacheInfo?.()
      if (owns()) setInfo(value ?? null)
    } catch {
      if (owns()) setError("Could not clear the library cache. Try again.")
    } finally { if (owns()) setClearing(false) }
  }
  return <div>
    <div className="flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white">Library Data</p>
        <p className="text-xs text-(--text-secondary) mt-0.5">
          {info ? `${info.collections} collections · ${info.items.toLocaleString()} items · ${info.snapshots} pages · ${(info.bytes / 1024 / 1024).toFixed(1)} MB` : provider?.getLibraryCacheInfo ? "Checking saved library data…" : "Connect a music library to manage its cache."}
        </p>
      </div>
      <button type="button" onClick={() => void clear()} disabled={clearing || !provider?.clearLibraryCache}
        className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:border-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
        {clearing ? "Clearing…" : "Clear"}
      </button>
    </div>
    {error && <p role="alert" className="text-xs text-(--text-secondary) mt-2">{error}</p>}
  </div>
}
