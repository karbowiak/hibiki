import { useState, useEffect, useRef } from "react"
import { useLocation } from "wouter"
import { useShallow } from "zustand/react/shallow"
import { open } from "@tauri-apps/plugin-shell"
import { useConnectionStore } from "./connectionStore"
import { useLibraryStore } from "../../stores/libraryStore"
import { plexAuthPoll, plexGetResources, testServerConnection } from "./api"
import type { PlexResource } from "./types"

type AuthState = "idle" | "polling" | "picking"

export function PlexSettings() {
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
  } = useConnectionStore(useShallow(s => ({
    connect: s.connect,
    disconnectAndClear: s.disconnectAndClear,
    startPlexAuth: s.startPlexAuth,
    isLoading: s.isLoading,
    isConnected: s.isConnected,
    error: s.error,
    clearError: s.clearError,
    baseUrl: s.baseUrl,
    token: s.token,
  })))
  const { fetchPlaylists, fetchRecentlyAdded, fetchHubs } = useLibraryStore(useShallow(s => ({ fetchPlaylists: s.fetchPlaylists, fetchRecentlyAdded: s.fetchRecentlyAdded, fetchHubs: s.fetchHubs })))
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
      void fetchPlaylists()
      void fetchRecentlyAdded(50)
      void fetchHubs()
      navigate("/")
    } else if (ok) {
      setAuthError("Connected, but no music library was found. Make sure a Music library has been shared with your account.")
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

    console.log("[connectToServer] Picked server:", resource.name, "connections:", resource.connections)

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

    console.log("[connectToServer] Candidates:", candidates.map(c => `${c.url} (local=${c.isLocal}, relay=${c.isRelay})`))

    if (candidates.length === 0) {
      setConnectingServer(null)
      setAuthError(`No connection URLs found for ${resource.name}.`)
      return
    }

    const results = await Promise.allSettled(
      candidates.map(async c => {
        try {
          const latency = await testServerConnection(c.url, authToken)
          console.log("[connectToServer] OK:", c.url, `${latency}ms`)
          return { ...c, latency }
        } catch (err) {
          console.log("[connectToServer] FAIL:", c.url, String(err))
          throw err
        }
      })
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

    console.log("[connectToServer] Successful:", successful.map(c => `${c.url} (${c.latency}ms)`))

    if (successful.length === 0) {
      setConnectingServer(null)
      setAuthError(`Could not reach ${resource.name}. All ${candidates.length} connection URL${candidates.length === 1 ? "" : "s"} failed.`)
      return
    }

    try {
      console.log("[connectToServer] Connecting to:", successful[0].url)
      await connect(successful[0].url, authToken, successful.map(c => c.url))
      const { isConnected: ok, musicSectionId: secId } = useConnectionStore.getState()
      console.log("[connectToServer] After connect: isConnected=%s, musicSectionId=%s", ok, secId)
      afterConnect()
    } catch (err) {
      console.error("[connectToServer] connect() failed:", err)
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
        <span className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${isConnected ? "bg-accent" : "bg-red-500"}`} />
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
            {isDisconnecting ? "Disconnecting..." : "Disconnect"}
          </button>
        )}
      </div>

      {/* Polling */}
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

      {/* Server picker */}
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
                        <span>{localConns[0].address}:{localConns[0].port} <span className="text-accent">local</span></span>
                      )}
                      {remoteConns.length > 0 && <span>{remoteConns.length} remote</span>}
                      {relayConns.length > 0 && <span>{relayConns.length} relay</span>}
                    </div>
                    {isConnectingThis && (
                      <p className="mt-1 text-xs text-[#e5a00d]/80">
                        Testing {r.connections.length + localConns.length} URLs...
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

      {/* Idle */}
      {authState === "idle" && (
        <div className="space-y-4">
          {connectingServer !== null ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <svg className="animate-spin text-[#e5a00d]" height="36" width="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
              <p className="text-sm text-white/70 text-center">
                Connecting to <span className="text-white font-medium">{connectingServer}</span>...
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
                    {isDisconnecting ? "Disconnecting..." : "Disconnect"}
                  </button>
                  <button
                    type="submit"
                    disabled={isLoading || !url.trim() || !token.trim()}
                    className="rounded-full bg-accent px-6 py-2 text-sm font-semibold text-black disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 active:scale-95 transition-all"
                  >
                    {isLoading ? "Connecting..." : isConnected && !isDirty ? "Reconnect" : "Save & Connect"}
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
