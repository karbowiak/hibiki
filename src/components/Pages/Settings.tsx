import { useState, useEffect, useRef } from "react"
import { useLocation } from "wouter"
import { open } from "@tauri-apps/plugin-shell"
import clsx from "clsx"
import { useConnectionStore, useLibraryStore } from "../../stores"
import { plexAuthPoll, plexGetResources, testServerConnection, audioCacheInfo, audioClearCache, audioSetCacheMaxBytes } from "../../lib/plex"
import type { PlexResource } from "../../types/plex"

type Section = "account" | "playback" | "downloads" | "ai" | "experience"
type AuthState = "idle" | "polling" | "picking"

const NAV: { id: Section; label: string; icon: React.ReactNode }[] = [
  {
    id: "account",
    label: "Account",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5.33 0-8 2.67-8 4v1h16v-1c0-1.33-2.67-4-8-4z" />
      </svg>
    ),
  },
  {
    id: "playback",
    label: "Playback",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
      </svg>
    ),
  },
  {
    id: "downloads",
    label: "Downloads",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 9h-4V3H9v6H5l7 7 7-7zm-8 2V5h2v6h1.17L12 13.17 9.83 11H11zm-6 7h14v2H5v-2z" />
      </svg>
    ),
  },
  {
    id: "ai",
    label: "AI",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L9.5 8.5 3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5L12 2zm0 4.24l1.5 3.88 3.88 1.5-3.88 1.5L12 17l-1.5-3.88L6.62 11.5l3.88-1.5L12 6.24z" />
      </svg>
    ),
  },
  {
    id: "experience",
    label: "Experience",
    icon: (
      <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5S18.33 12 17.5 12z" />
      </svg>
    ),
  },
]

// ---------------------------------------------------------------------------
// Playback section — audio cache controls
// ---------------------------------------------------------------------------

const CACHE_SIZE_KEY = "plexify-audio-cache-max-bytes"

const CACHE_OPTIONS = [
  { label: "256 MB", bytes: 268_435_456 },
  { label: "512 MB", bytes: 536_870_912 },
  { label: "1 GB", bytes: 1_073_741_824 },
  { label: "2 GB", bytes: 2_147_483_648 },
  { label: "4 GB", bytes: 4_294_967_296 },
  { label: "Unlimited", bytes: 0 },
] as const

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function PlaybackSection() {
  const [cacheInfo, setCacheInfo] = useState<{ size_bytes: number; file_count: number } | null>(null)
  const [maxBytes, setMaxBytes] = useState<number>(1_073_741_824)
  const [isClearing, setIsClearing] = useState(false)

  useEffect(() => {
    // Restore and apply saved cache limit.
    const saved = localStorage.getItem(CACHE_SIZE_KEY)
    const savedBytes = saved !== null ? parseInt(saved, 10) : 1_073_741_824
    if (!isNaN(savedBytes)) {
      setMaxBytes(savedBytes)
      void audioSetCacheMaxBytes(savedBytes).catch(() => {})
    }
    void audioCacheInfo().then(info => setCacheInfo(info)).catch(() => {})
  }, [])

  async function handleMaxChange(bytes: number) {
    setMaxBytes(bytes)
    localStorage.setItem(CACHE_SIZE_KEY, String(bytes))
    await audioSetCacheMaxBytes(bytes).catch(() => {})
  }

  async function handleClear() {
    setIsClearing(true)
    try {
      await audioClearCache()
      const info = await audioCacheInfo()
      setCacheInfo(info)
    } finally {
      setIsClearing(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Cache size limit */}
      <div>
        <h3 className="text-base font-semibold text-white mb-1">Audio Cache Size</h3>
        <p className="text-sm text-white/40 mb-3">
          Tracks are cached to disk for instant replay. Older files are removed automatically when the limit is reached.
        </p>
        <div className="flex gap-2 flex-wrap">
          {CACHE_OPTIONS.map(opt => (
            <button
              key={opt.bytes}
              onClick={() => void handleMaxChange(opt.bytes)}
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
                maxBytes === opt.bytes
                  ? "bg-[#1db954] text-black font-semibold"
                  : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Cache usage + clear */}
      <div>
        <h3 className="text-base font-semibold text-white mb-1">Cache Usage</h3>
        {cacheInfo ? (
          <p className="text-sm text-white/40 mb-3">
            {formatBytes(cacheInfo.size_bytes)} used · {cacheInfo.file_count} {cacheInfo.file_count === 1 ? "file" : "files"}
          </p>
        ) : (
          <p className="text-sm text-white/30 mb-3">Loading…</p>
        )}
        <button
          onClick={() => void handleClear()}
          disabled={isClearing || cacheInfo?.file_count === 0}
          className="rounded-md bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isClearing ? "Clearing…" : "Clear Audio Cache"}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Placeholder for unimplemented sections
// ---------------------------------------------------------------------------

function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-white/40">{description}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Account section — connection + Plex OAuth
// ---------------------------------------------------------------------------

function AccountSection() {
  const {
    connect,
    disconnectAndClear,
    startPlexAuth,
    isLoading,
    isConnected,
    error,
    clearError,
    baseUrl: savedUrl,
    token: savedToken,
  } = useConnectionStore()
  const { fetchPlaylists, fetchRecentlyAdded, fetchHubs } = useLibraryStore()
  const [, navigate] = useLocation()

  const [url, setUrl] = useState(savedUrl)
  const [token, setToken] = useState(savedToken)
  const [showToken, setShowToken] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [showManual, setShowManual] = useState(false)

  const [authState, setAuthState] = useState<AuthState>("idle")
  const [resources, setResources] = useState<PlexResource[]>([])
  const [pendingToken, setPendingToken] = useState("")
  const [authError, setAuthError] = useState<string | null>(null)
  const [connectingServer, setConnectingServer] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pinIdRef = useRef<number | null>(null)
  const pollCountRef = useRef(0)
  const MAX_POLLS = 150

  useEffect(() => {
    setUrl(savedUrl)
    setToken(savedToken)
  }, [savedUrl, savedToken])

  useEffect(() => {
    useConnectionStore.setState({ isLoading: false })
  }, [])

  useEffect(() => () => stopPolling(), [])

  const isDirty = url.trim() !== savedUrl || token.trim() !== savedToken

  function stopPolling() {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    pinIdRef.current = null
    pollCountRef.current = 0
  }

  function afterConnect() {
    const { isConnected: ok, musicSectionId } = useConnectionStore.getState()
    if (ok && musicSectionId !== null) {
      void fetchPlaylists(musicSectionId)
      void fetchRecentlyAdded(musicSectionId, 50)
      void fetchHubs(musicSectionId)
      navigate("/")
    }
  }

  const handlePlexSignIn = async () => {
    clearError()
    setAuthError(null)
    try {
      const pin = await startPlexAuth()
      pinIdRef.current = pin.pin_id
      pollCountRef.current = 0
      await open(pin.auth_url)
      setAuthState("polling")

      pollRef.current = setInterval(async () => {
        if (pinIdRef.current === null) return
        pollCountRef.current += 1
        if (pollCountRef.current >= MAX_POLLS) {
          stopPolling()
          setAuthState("idle")
          setAuthError("Sign-in timed out after 5 minutes. Please try again.")
          return
        }
        try {
          const authToken = await plexAuthPoll(pinIdRef.current)
          if (!authToken) return
          stopPolling()
          setPendingToken(authToken)
          const servers = await plexGetResources(authToken)
          if (servers.length === 0) {
            setAuthState("idle")
            setAuthError("No Plex servers found on your account. Try connecting manually.")
            return
          }
          if (servers.length === 1) {
            setAuthState("idle")
            await connectToServer(servers[0], authToken)
          } else {
            setResources(servers)
            setAuthState("picking")
          }
        } catch (err) {
          stopPolling()
          setAuthState("idle")
          setAuthError(String(err))
        }
      }, 2000)
    } catch (err) {
      setAuthError(String(err))
    }
  }

  const connectToServer = async (resource: PlexResource, authToken: string) => {
    setConnectingServer(resource.name)
    setAuthError(null)

    interface Candidate { url: string; isLocal: boolean; isHttps: boolean; isRelay: boolean }
    const seen = new Set<string>()
    const candidates: Candidate[] = []

    for (const conn of resource.connections) {
      if (conn.local) {
        const httpUrl = `http://${conn.address}:${conn.port}`
        if (!seen.has(httpUrl)) {
          seen.add(httpUrl)
          candidates.push({ url: httpUrl, isLocal: true, isHttps: false, isRelay: false })
        }
      }
      if (conn.uri && !seen.has(conn.uri)) {
        seen.add(conn.uri)
        candidates.push({ url: conn.uri, isLocal: conn.local, isHttps: conn.uri.startsWith("https://"), isRelay: conn.relay })
      }
    }

    if (candidates.length === 0) {
      setConnectingServer(null)
      setAuthError(`No connection URLs found for ${resource.name}.`)
      return
    }

    const results = await Promise.allSettled(
      candidates.map(async c => ({ ...c, latency: await testServerConnection(c.url, authToken) }))
    )
    const successful = results
      .filter((r): r is PromiseFulfilledResult<Candidate & { latency: number }> => r.status === "fulfilled")
      .map(r => r.value)
      .sort((a, b) => {
        if (a.isRelay !== b.isRelay) return a.isRelay ? 1 : -1
        if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1
        if (a.isHttps !== b.isHttps) return a.isHttps ? -1 : 1
        return a.latency - b.latency
      })

    if (successful.length === 0) {
      setConnectingServer(null)
      setAuthError(`Could not reach ${resource.name}. All ${candidates.length} connection URL${candidates.length === 1 ? "" : "s"} failed.`)
      return
    }

    try {
      await connect(successful[0].url, authToken, successful.map(c => c.url))
      afterConnect()
    } catch (err) {
      setAuthError(String(err))
    } finally {
      setConnectingServer(null)
    }
  }

  const handlePickServer = (resource: PlexResource) => void connectToServer(resource, pendingToken)

  const handleManualSave = async (e: React.FormEvent) => {
    e.preventDefault()
    clearError()
    await connect(url.trim(), token.trim())
    afterConnect()
  }

  const handleDisconnect = async () => {
    setIsDisconnecting(true)
    await disconnectAndClear()
    setUrl("")
    setToken("")
    setIsDisconnecting(false)
  }

  return (
    <div className="max-w-xl space-y-8">
      {/* Connection status */}
      <div className="flex items-center gap-3 rounded-xl bg-white/5 px-5 py-4">
        <span className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${isConnected ? "bg-[#1db954]" : "bg-red-500"}`} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-white">
            {isConnected ? "Connected" : "Not connected"}
          </p>
          {isConnected && (
            <p className="mt-0.5 truncate text-xs text-white/40">{savedUrl}</p>
          )}
        </div>
        {isConnected && !showManual && (
          <button
            onClick={handleDisconnect}
            disabled={isDisconnecting}
            className="ml-auto flex-shrink-0 rounded-full border border-white/20 px-4 py-1.5 text-xs font-semibold text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-30 transition-colors"
          >
            {isDisconnecting ? "Disconnecting…" : "Disconnect"}
          </button>
        )}
      </div>

      {/* ── Polling ── */}
      {authState === "polling" && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-3 py-8">
            <svg className="animate-spin text-[#e5a00d]" height="36" width="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
            <p className="text-sm text-white/70 text-center">
              A browser window has opened.<br />
              Sign in to Plex, then return here.
            </p>
          </div>
          <button
            onClick={() => { stopPolling(); setAuthState("idle"); setAuthError(null) }}
            className="w-full rounded-full border border-white/20 py-2.5 text-sm font-semibold text-white/60 hover:bg-white/10 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Server picker ── */}
      {authState === "picking" && (
        <div className="space-y-3">
          <p className="text-sm text-white/60">Choose a server to connect to:</p>
          <ul className="space-y-2">
            {resources.map(r => {
              const localConns = r.connections.filter(c => c.local && !c.relay)
              const remoteConns = r.connections.filter(c => !c.local && !c.relay)
              const relayConns = r.connections.filter(c => c.relay)
              const isConnectingThis = connectingServer === r.name
              const isDisabled = connectingServer !== null
              return (
                <li key={r.client_identifier}>
                  <button
                    onClick={() => handlePickServer(r)}
                    disabled={isDisabled}
                    className="w-full rounded-xl bg-white/5 px-5 py-3.5 text-left hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-white">{r.name}</span>
                      {isConnectingThis && (
                        <svg className="animate-spin text-[#e5a00d] flex-shrink-0" height="14" width="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                          <path d="M12 2a10 10 0 0 1 10 10" />
                        </svg>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-white/40 flex flex-wrap gap-x-3">
                      {localConns.length > 0 && (
                        <span>{localConns[0].address}:{localConns[0].port} <span className="text-[#1db954]">local</span></span>
                      )}
                      {remoteConns.length > 0 && <span>{remoteConns.length} remote</span>}
                      {relayConns.length > 0 && <span>{relayConns.length} relay</span>}
                    </div>
                    {isConnectingThis && (
                      <p className="mt-1 text-xs text-[#e5a00d]/80">
                        Testing {r.connections.length + localConns.length} URLs…
                      </p>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
          {authError && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
              {authError}
            </div>
          )}
          <button
            onClick={() => { setAuthState("idle"); setAuthError(null) }}
            disabled={connectingServer !== null}
            className="w-full rounded-full border border-white/20 py-2.5 text-sm font-semibold text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Back
          </button>
        </div>
      )}

      {/* ── Idle ── */}
      {authState === "idle" && (
        <div className="space-y-4">
          {connectingServer !== null ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <svg className="animate-spin text-[#e5a00d]" height="36" width="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
              <p className="text-sm text-white/70 text-center">
                Connecting to <span className="text-white font-medium">{connectingServer}</span>…
              </p>
            </div>
          ) : (
            <button
              onClick={() => void handlePlexSignIn()}
              className="flex w-full items-center justify-center gap-3 rounded-full bg-[#e5a00d] py-3 text-sm font-bold text-black hover:bg-[#f0aa10] active:scale-95 transition-all"
            >
              <svg height="18" width="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.994 2C6.477 2 2 6.477 2 11.994S6.477 22 11.994 22 22 17.523 22 12.006 17.523 2 11.994 2zm5.284 12.492l-7.285 4.206a.566.566 0 0 1-.567 0 .572.572 0 0 1-.284-.491V5.793c0-.202.109-.39.284-.491a.566.566 0 0 1 .567 0l7.285 4.206a.572.572 0 0 1 .284.491c0 .204-.108.39-.284.493z" />
              </svg>
              Sign in with Plex
            </button>
          )}

          {authError && connectingServer === null && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
              {authError}
            </div>
          )}

          {connectingServer === null && <>
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-white/10" />
              <button
                onClick={() => setShowManual(v => !v)}
                className="text-xs text-white/30 hover:text-white/60 transition-colors"
              >
                {showManual ? "hide manual" : "or connect manually"}
              </button>
              <div className="h-px flex-1 bg-white/10" />
            </div>

            {showManual && (
              <form onSubmit={handleManualSave} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-white/50 uppercase tracking-wider">
                    Server URL
                  </label>
                  <input
                    type="text"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder="http://192.168.1.100:32400"
                    className="w-full rounded-xl bg-white/10 px-4 py-3 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-white/30 transition-colors"
                    autoFocus={!isConnected}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-white/50 uppercase tracking-wider">
                    Plex Token
                  </label>
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      value={token}
                      onChange={e => setToken(e.target.value)}
                      placeholder="Your Plex auth token"
                      className="w-full rounded-xl bg-white/10 px-4 py-3 pr-11 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-white/30 transition-colors"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
                      tabIndex={-1}
                    >
                      {showToken ? (
                        <svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                        </svg>
                      ) : (
                        <svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
                    {error}
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={handleDisconnect}
                    disabled={isDisconnecting || (!isConnected && !savedUrl)}
                    className="rounded-full px-4 py-2 text-sm font-semibold text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    {isDisconnecting ? "Disconnecting…" : "Disconnect"}
                  </button>
                  <button
                    type="submit"
                    disabled={isLoading || !url.trim() || !token.trim()}
                    className="rounded-full bg-[#1db954] px-6 py-2 text-sm font-semibold text-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#1ed760] active:scale-95 transition-all"
                  >
                    {isLoading ? "Connecting…" : isConnected && !isDirty ? "Reconnect" : "Save & Connect"}
                  </button>
                </div>
              </form>
            )}
          </>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const [section, setSection] = useState<Section>("account")

  return (
    <div className="flex h-full">
      {/* Inner sidebar */}
      <aside className="w-52 flex-shrink-0 border-r border-white/5 p-6 pt-8">
        <p className="mb-4 text-[11px] font-bold uppercase tracking-widest text-white/25">Settings</p>
        <nav>
          <ul className="space-y-0.5">
            {NAV.map(item => (
              <li key={item.id}>
                <button
                  onClick={() => setSection(item.id)}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    section === item.id
                      ? "bg-white/10 text-white"
                      : "text-white/50 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <span className={clsx("flex-shrink-0", section === item.id ? "text-white" : "text-white/40")}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-auto p-10 pt-8">
        <h1 className="mb-8 text-2xl font-bold">
          {NAV.find(n => n.id === section)?.label}
        </h1>

        {section === "account" && <AccountSection />}
        {section === "playback" && <PlaybackSection />}
        {section === "downloads" && (
          <ComingSoon title="Downloads" description="Offline caching and download quality settings will appear here." />
        )}
        {section === "ai" && (
          <ComingSoon title="AI" description="Sonic recommendations, radio tuning and smart mix settings will appear here." />
        )}
        {section === "experience" && (
          <ComingSoon title="Experience" description="Theme, animations, language and display settings will appear here." />
        )}
      </main>
    </div>
  )
}
