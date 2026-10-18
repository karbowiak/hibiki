import { Switch } from "../../components/shared/Checkbox"
import { Button } from "../../components/shared/Button"
import { useState } from "react"
import { useLocation } from "wouter"
import { openUrl as open } from "@tauri-apps/plugin-opener"
import { useLastfmStore } from "./authStore"
import { useLastfmMetadataStore } from "./store"
import { lastfmSaveCredentials, lastfmGetToken } from "./api"

type LastfmAuthStep = "idle" | "waiting"

export function LastfmSettings() {
  const {
    isAuthenticated,
    isEnabled,
    username,
    setEnabled,
    completeAuth,
    disconnect,
  } = useLastfmStore()

  const lastfmMetadata = useLastfmMetadataStore()
  const lastfmStats = lastfmMetadata.stats()

  const [apiKey, setApiKey] = useState("")
  const [apiSecret, setApiSecret] = useState("")
  const [authStep, setAuthStep] = useState<LastfmAuthStep>("idle")
  const [pendingToken, setPendingToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [clearing, setClearing] = useState(false)

  async function handleConnect() {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setError("Please enter both API Key and API Secret.")
      return
    }
    setError(null)
    setIsConnecting(true)
    try {
      await lastfmSaveCredentials(apiKey.trim(), apiSecret.trim())
      const { token, auth_url } = await lastfmGetToken()
      setPendingToken(token)
      await open(auth_url)
      setAuthStep("waiting")
    } catch (e) {
      setError(String(e))
    } finally {
      setIsConnecting(false)
    }
  }

  async function handleComplete() {
    setError(null)
    setIsConnecting(true)
    try {
      await completeAuth(pendingToken)
      setAuthStep("idle")
      setPendingToken("")
      setApiKey("")
      setApiSecret("")
    } catch (e) {
      setError(`Could not complete auth: ${String(e)}`)
    } finally {
      setIsConnecting(false)
    }
  }

  function handleCancel() {
    setAuthStep("idle")
    setPendingToken("")
    setError(null)
  }

  function handleClearCache() {
    setClearing(true)
    lastfmMetadata.clearCache()
    setTimeout(() => setClearing(false), 400)
  }

  const [, navigate] = useLocation()

  return (
    <div className="max-w-2xl space-y-8">
      {/* Account & Auth */}
      <div className="space-y-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/30">
          Account
        </h2>

        {!isAuthenticated ? (
          authStep === "idle" ? (
            <div className="space-y-4">
              <p className="text-sm text-white/50">
                Connect your Last.fm account to enable scrobbling and metadata
                enrichment.{" "}
                <Button
                  variant="bare"
                  className="text-accent/80 underline-offset-2 hover:text-accent hover:underline"
                  onClick={() =>
                    void open("https://www.last.fm/api/account/create")
                  }
                >
                  Get your free API key
                </Button>
              </p>
              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-white/50">
                    API Key
                  </label>
                  <input
                    type="text"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="32-character hex key"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/20 focus:border-accent/50 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-white/50">
                    API Secret
                  </label>
                  <input
                    type="password"
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    placeholder="32-character secret"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/20 focus:border-accent/50 focus:outline-none"
                  />
                </div>
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <Button
                variant="primary"
                onClick={() => void handleConnect()}
                disabled={isConnecting || !apiKey.trim() || !apiSecret.trim()}
                className="rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
              >
                {isConnecting ? "Opening browser..." : "Connect to Last.fm"}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-4">
                <p className="text-sm font-medium text-white">
                  Complete Connection
                </p>
                <ol className="list-inside list-decimal space-y-1 text-sm text-white/60">
                  <li>Approve the request in your browser.</li>
                  <li>
                    Return here and click{" "}
                    <strong className="text-white">Complete</strong>.
                  </li>
                </ol>
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <div className="flex gap-3">
                <Button
                  variant="primary"
                  onClick={() => void handleComplete()}
                  disabled={isConnecting}
                  className="rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {isConnecting ? "Connecting..." : "Complete Connection"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleCancel}
                  className="rounded-lg border border-white/10 px-4 py-2 text-sm transition-colors hover:border-white/25"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white">
                lfm
              </div>
              <div>
                <p className="text-sm font-medium text-white">{username}</p>
                <p className="text-xs text-white/40">Connected to Last.fm</p>
              </div>
            </div>

            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-white">Scrobbling</p>
                <p className="text-xs text-white/40">
                  Report what you're listening to Last.fm
                </p>
              </div>
              <Switch aria-label="Scrobbling" checked={isEnabled}  onChange={() => void setEnabled(!isEnabled)} />
            </div>

            <div className="flex items-center justify-between gap-4 py-2">
              <div>
                <p className="text-sm font-medium text-white">Loved tracks</p>
                <p className="text-xs text-white/40">
                  Configure two-way favorites sync in Liked Songs → Sync.
                </p>
              </div>
              <Button
                size="md"
                variant="secondary"
                className="media-secondary shrink-0"
                onClick={() => navigate("/collection/tracks")}
              >
                Liked Songs
              </Button>
            </div>

            <Button
              variant="bare"
              onClick={() => void disconnect()}
              className="text-sm text-red-400 transition-colors hover:text-red-300"
            >
              Disconnect
            </Button>
          </div>
        )}
      </div>

      {/* Cache */}
      <div>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-white/30">
          Metadata Cache
        </h2>
        <div className="bg-white/3 divide-y divide-white/5 rounded-xl border border-white/10">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-white/60">Artists</span>
            <span className="text-sm font-medium tabular-nums text-white">
              {lastfmStats.artistCount}
            </span>
          </div>
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-white/60">Albums</span>
            <span className="text-sm font-medium tabular-nums text-white">
              {lastfmStats.albumCount}
            </span>
          </div>
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-white/60">Tracks</span>
            <span className="text-sm font-medium tabular-nums text-white">
              {lastfmStats.trackCount}
            </span>
          </div>
        </div>
        <Button
          variant="secondary"
          onClick={handleClearCache}
          disabled={
            clearing ||
            lastfmStats.artistCount +
              lastfmStats.albumCount +
              lastfmStats.trackCount ===
              0
          }
          className="mt-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs transition-colors hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {clearing ? "Cleared" : "Clear Cache"}
        </Button>
      </div>
    </div>
  )
}
