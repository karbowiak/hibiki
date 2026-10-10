import { useLibraryStore } from "../../stores/libraryStore"

// ── Plex WebSocket notification types ────────────────────────────────

interface TimelineEntry {
  identifier: string
  itemID: number
  sectionID: number
  state: number
  title: string
  type: number
  updatedAt: number
}

interface ActivityNotification {
  Activity: {
    cancellable: boolean
    progress: number
    subtitle: string
    title: string
    type: string
    userID: number
    uuid: string
  }
  event: string
  uuid: string
}

interface NotificationContainer {
  NotificationContainer: {
    type: string
    size: number
    TimelineEntry?: TimelineEntry[]
    ActivityNotification?: ActivityNotification[]
  }
}

// ── Constants ────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const DEBOUNCE_MS = 2_000
const REFRESH_COOLDOWN_MS = 10_000
const PROGRESS_THROTTLE_MS = 1_000

// ── WebSocket Manager ────────────────────────────────────────────────

export class PlexWebSocketManager {
  private ws: WebSocket | null = null
  private baseUrl = ""
  private token = ""
  private musicSectionId = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private _connected = false
  private _isScanning = false
  private _lastRefreshAt = 0
  private _refreshInFlight = false
  private _lastProgressUpdate = 0

  constructor(
    private readonly getStore = () => useLibraryStore.getState(),
    private readonly createSocket = (url: string) => new WebSocket(url),
  ) {}

  get isConnected() {
    return this._connected
  }

  connect(baseUrl: string, token: string, musicSectionId: number) {
    this.baseUrl = baseUrl
    this.token = token
    this.musicSectionId = musicSectionId
    this.intentionalClose = false
    this.reconnectAttempts = 0
    this.openSocket()
  }

  disconnect() {
    this.intentionalClose = true
    this.clearTimers()
    if (this.ws) {
      this.retireSocket()
    }
    this.baseUrl = ""
    this.token = ""
    this._isScanning = false
    this.setConnected(false)
    this.setScanning(false)
  }

  // ── Private ──────────────────────────────────────────────────────

  private openSocket() {
    if (this.ws) {
      this.retireSocket()
    }

    const endpoint = new URL(this.baseUrl)
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:"
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/:/websockets/notifications`
    endpoint.search = ""
    endpoint.searchParams.set("X-Plex-Token", this.token)
    let ws: WebSocket
    try { ws = this.createSocket(endpoint.toString()) }
    catch { this.setConnected(false); this.scheduleReconnect(); return }
    this.ws = ws
    const active = () => !this.intentionalClose && this.ws === ws

    ws.onopen = () => {
      if (!active()) return
      this.reconnectAttempts = 0
      this.setConnected(true)
      console.log("[PlexWS] Connected")
    }

    ws.onmessage = (event) => {
      if (!active()) return
      try {
        const data = JSON.parse(event.data as string) as NotificationContainer
        this.handleMessage(data)
      } catch {
        // Ignore malformed messages
      }
    }

    ws.onclose = () => {
      if (!active()) return
      this.ws = null
      this.setConnected(false)
      if (!this.intentionalClose) {
        this.scheduleReconnect()
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror, which handles reconnection
    }

  }

  private retireSocket() {
    const socket = this.ws
    this.ws = null
    if (socket) { socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close() }
  }

  private handleMessage(data: NotificationContainer) {
    const container = data.NotificationContainer
    if (!container) return

    if (container.type === "timeline" && container.TimelineEntry) {
      this.handleTimeline(container.TimelineEntry)
    }

    if (container.type === "activity" && container.ActivityNotification) {
      this.handleActivity(container.ActivityNotification)
    }
  }

  private handleTimeline(entries: TimelineEntry[]) {
    // Suppress all timeline-driven refreshes while a scan is active —
    // those are intermediate states and we'll refresh once when the scan ends.
    if (this._isScanning) return

    const relevant = entries.filter(
      e => e.identifier === "com.plexapp.plugins.library" && e.sectionID === this.musicSectionId,
    )
    if (relevant.length === 0) return

    const needsRefresh = relevant.some(e => e.state === 0 || e.state === 5 || e.state === 9)
    if (needsRefresh) {
      this.scheduleRefresh()
    }
  }

  private handleActivity(notifications: ActivityNotification[]) {
    for (const n of notifications) {
      if (n.Activity.type !== "library.update.section") continue

      if (n.event === "started") {
        this._isScanning = true
        this._lastProgressUpdate = Date.now()
        this.setScanning(true, n.Activity.progress)
      } else if (n.event === "updated") {
        this._isScanning = true
        // Throttle progress state updates to avoid overwhelming the webview
        const now = Date.now()
        if (now - this._lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
          this._lastProgressUpdate = now
          this.setScanning(true, n.Activity.progress)
        }
      } else if (n.event === "ended") {
        this._isScanning = false
        this.setScanning(false)
        // Single refresh after scan completes — bypass cooldown
        this.scheduleRefresh(true)
      }
    }
  }

  /**
   * Schedule a debounced refresh. If `bypassCooldown` is false (default),
   * the refresh is skipped when still within the cooldown window.
   */
  private scheduleRefresh(bypassCooldown = false) {
    // If we're within cooldown and not bypassing, skip entirely
    if (!bypassCooldown && Date.now() - this._lastRefreshAt < REFRESH_COOLDOWN_MS) {
      console.log("[PlexWS] Refresh skipped (cooldown)")
      return
    }

    // Cancel any pending debounce — the latest call wins
    if (this.debounceTimer) clearTimeout(this.debounceTimer)

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.doRefresh()
    }, DEBOUNCE_MS)
  }

  private doRefresh() {
    // Guard against overlapping refreshes
    if (this._refreshInFlight) return

    this._refreshInFlight = true
    this._lastRefreshAt = Date.now()

    const store = this.getStore()
    // Only invalidate TTL timestamps — do NOT nuke playlist/mix caches
    store.invalidateLibraryTTLs()

    console.log("[PlexWS] Refreshing library data")
    void store.refreshAll().catch(() => {}).finally(() => {
      this._refreshInFlight = false
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS,
    )
    this.reconnectAttempts++
    console.log(`[PlexWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.intentionalClose) this.openSocket()
    }, delay)
  }

  private clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private setConnected(connected: boolean) {
    this._connected = connected
    this.getStore().setWsConnected(connected)
  }

  private setScanning(scanning: boolean, progress?: number) {
    this.getStore().setLibraryScanning(scanning, progress ?? null)
  }
}
