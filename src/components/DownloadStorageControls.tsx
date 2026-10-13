import { useEffect, useState } from "react"
import { Link } from "wouter"
import { useProviderStore } from "../stores/providerStore"

export function DownloadStorageControls() {
  const provider = useProviderStore((state) => state.provider)
  const [bytes, setBytes] = useState<number | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true,
      pending = false
    setBytes(null)
    setError(false)
    async function refresh() {
      if (!provider?.getLocalAudio || pending) return
      pending = true
      try {
        const page = await provider.getLocalAudio(0, 1, false)
        if (active) {
          setBytes(page.downloadedBytes)
          setError(false)
        }
      } catch {
        if (active) setError(true)
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [provider])
  const usage =
    bytes == null
      ? error
        ? "Download storage unavailable"
        : provider?.getLocalAudio
          ? "Loading storage…"
          : "Connect a Plex library to manage downloads"
      : bytes >= 1024 ** 3
        ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
        : `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return (
    <div className="text-sm text-[var(--text-secondary)]">
      <p aria-live="polite" className="font-medium text-[var(--text-primary)]">
        {usage}
      </p>
      <p className="mt-2">
        Use an item's menu to download missing tracks or remove its download.
        Songs shared with other downloaded collections stay saved.
      </p>
      <Link
        href="/library"
        className="mt-3 inline-block rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-app-surface-hover"
      >
        Browse your library
      </Link>
    </div>
  )
}
