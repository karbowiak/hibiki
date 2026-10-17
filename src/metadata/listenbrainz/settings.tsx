import { useState } from "react"
import { openUrl as open } from "@tauri-apps/plugin-opener"
import { useListenBrainzStore } from "./authStore"
import { useMbidStore } from "../musicbrainz/mbidStore"

export function ListenBrainzSettings() {
  const { isAuthenticated, isEnabled, username, saveToken, setEnabled, disconnect } = useListenBrainzStore()
  const mbidRecordings = useMbidStore(s => Object.keys(s.recordings).length)
  const clearMbidCache = useMbidStore(s => s.clearCache)
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [clearing, setClearing] = useState(false)

  async function handleSave() {
    if (!token.trim()) {
      setError("Please enter your ListenBrainz user token.")
      return
    }
    setError(null)
    setIsSaving(true)
    try {
      await saveToken(token.trim())
      setToken("")
    } catch (e) {
      setError(String(e))
    } finally {
      setIsSaving(false)
    }
  }

  function handleClearMbids() {
    setClearing(true)
    clearMbidCache()
    setTimeout(() => setClearing(false), 400)
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="space-y-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/30">Account</h2>

        {!isAuthenticated ? (
          <div className="space-y-4">
            <p className="text-sm text-white/50">
              Connect your ListenBrainz account to enable scrobbling.{" "}
              <button
                className="text-accent/80 hover:text-accent underline-offset-2 hover:underline"
                onClick={() => void open("https://listenbrainz.org/settings/")}
              >
                Get your user token
              </button>
            </p>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-white/50">User Token</label>
              <input
                type="password"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="Paste your ListenBrainz user token"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/20 focus:border-accent/50 focus:outline-none"
                onKeyDown={e => { if (e.key === "Enter") void handleSave() }}
              />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              onClick={() => void handleSave()}
              disabled={isSaving || !token.trim()}
              className="rounded-lg bg-accent/80 hover:bg-accent px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
            >
              {isSaving ? "Validating..." : "Save Token"}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-[#353070] flex items-center justify-center text-white text-xs font-bold">
                LB
              </div>
              <div>
                <p className="text-sm font-medium text-white">{username}</p>
                <p className="text-xs text-white/40">Connected to ListenBrainz</p>
              </div>
            </div>

            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-white">Scrobbling</p>
                <p className="text-xs text-white/40">Report what you're listening to ListenBrainz</p>
              </div>
              <button
                onClick={() => void setEnabled(!isEnabled)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  isEnabled ? "bg-accent" : "bg-white/20"
                }`}
                role="switch"
                aria-checked={isEnabled}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    isEnabled ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            <button
              onClick={() => void disconnect()}
              className="text-sm text-red-400 hover:text-red-300 transition-colors"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* MBID Cache */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/30 mb-4">MusicBrainz ID Cache</h2>
        <p className="text-xs text-white/40 mb-4">
          Recording MBIDs are resolved from MusicBrainz and included with each scrobble for accurate matching.
        </p>
        <div className="rounded-xl border border-white/10 bg-white/3 divide-y divide-white/5">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-white/60">Recordings</span>
            <span className="text-sm font-medium text-white tabular-nums">{mbidRecordings}</span>
          </div>
        </div>
        <button
          onClick={handleClearMbids}
          disabled={clearing || mbidRecordings === 0}
          className="mt-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:border-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {clearing ? "Cleared" : "Clear Cache"}
        </button>
      </div>
    </div>
  )
}
