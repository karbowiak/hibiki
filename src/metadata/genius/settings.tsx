import { Switch } from "../../components/shared/Checkbox"
import { Button } from "../../components/shared/Button"
import { useState } from "react"
import { useGeniusStore } from "./authStore"

export function GeniusSettings() {
  const { hasCredentials, isEnabled, alwaysFetch, saveCredentials, setEnabled, setAlwaysFetch, disconnect } =
    useGeniusStore()

  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  async function handleSave() {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError("Please enter both Client ID and Client Secret.")
      return
    }
    setError(null)
    setIsSaving(true)
    try {
      await saveCredentials(clientId.trim(), clientSecret.trim())
      setClientId("")
      setClientSecret("")
    } catch (e) {
      setError(String(e))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-white/30">Account</h2>

      {!hasCredentials ? (
        <div className="space-y-4">
          <p className="text-sm text-white/50">
            Connect your Genius account to fetch lyrics when Plex doesn't have them.{" "}
            <a
              href="https://genius.com/api-clients"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent/80 hover:text-accent underline-offset-2 hover:underline"
            >
              Create a Genius API client
            </a>
          </p>
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-white/50">Client ID</label>
              <input
                type="text"
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                placeholder="Genius Client ID"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/20 focus:border-accent/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-white/50">Client Secret</label>
              <input
                type="password"
                value={clientSecret}
                onChange={e => setClientSecret(e.target.value)}
                placeholder="Genius Client Secret"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/20 focus:border-accent/50 focus:outline-none"
              />
            </div>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={isSaving || !clientId.trim() || !clientSecret.trim()}
            className="rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {isSaving ? "Saving..." : "Save Credentials"}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-yellow-600 flex items-center justify-center text-white text-xs font-bold">
              G
            </div>
            <div>
              <p className="text-sm font-medium text-white">Genius</p>
              <p className="text-xs text-white/40">Connected</p>
            </div>
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-white">Enable Genius Lyrics</p>
              <p className="text-xs text-white/40">Fetch lyrics from Genius when Plex has none</p>
            </div>
            <Switch aria-label="Enable Genius Lyrics" checked={isEnabled}  onChange={() => void setEnabled(!isEnabled)} />
          </div>

          {isEnabled && (
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-white">Fetch even when Plex has lyrics</p>
                <p className="text-xs text-white/40">Show both Plex and Genius lyrics as selectable sources</p>
              </div>
              <Switch aria-label="Fetch even when Plex has lyrics" checked={alwaysFetch}  onChange={() => void setAlwaysFetch(!alwaysFetch)} />
            </div>
          )}

          <Button
            variant="bare"
            onClick={() => void disconnect()}
            className="text-sm text-red-400 hover:text-red-300 transition-colors"
          >
            Disconnect
          </Button>
        </div>
      )}
    </div>
  )
}
