import { useLibraryStore } from "../../stores/libraryStore"
import type { CatalogueChange } from "../../offline/catalogue"

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
const MAX_PENDING_CHANGES = 2_000
const NOTIFY_BATCH_SIZE = 200
type Timer = ReturnType<typeof setTimeout>
interface SocketClock {
  now(): number
  setTimeout(callback: () => void, delay: number): Timer
  clearTimeout(timer: Timer): void
}
const systemClock: SocketClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
}
function positiveId(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+$/.test(value))
  )
    return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

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
  private generation = 0
  private pendingChanges = new Map<string, CatalogueChange>()
  private catchUpPending = false
  private notifyTimer: Timer | null = null
  private notifyInFlight = false

  constructor(
    private readonly getStore = () => useLibraryStore.getState(),
    private readonly createSocket = (url: string) => new WebSocket(url),
    private readonly notifyCatalogue?: (
      changes: CatalogueChange[],
      catchUp: boolean
    ) => Promise<void>,
    private readonly clock: SocketClock = systemClock
  ) {}

  get isConnected() {
    return this._connected
  }

  connect(baseUrl: string, token: string, musicSectionId: number) {
    this.clearTimers()
    this.retireSocket()
    this.generation++
    this.pendingChanges.clear()
    this.catchUpPending = false
    this.notifyInFlight = false
    this._refreshInFlight = false
    if (this._isScanning) {
      this._isScanning = false
      this.setScanning(false)
    }
    this.baseUrl = baseUrl
    this.token = token
    this.musicSectionId = musicSectionId
    this.intentionalClose = false
    this.reconnectAttempts = 0
    this.openSocket()
  }

  disconnect() {
    this.generation++
    this.intentionalClose = true
    this.clearTimers()
    this.pendingChanges.clear()
    this.catchUpPending = false
    this.notifyInFlight = false
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
    try {
      ws = this.createSocket(endpoint.toString())
    } catch {
      this.setConnected(false)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    const active = () => !this.intentionalClose && this.ws === ws

    ws.onopen = () => {
      if (!active()) return
      this.reconnectAttempts = 0
      this.setConnected(true)
      this.requestCatchUp()
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
      if (this._isScanning) {
        this._isScanning = false
        this.setScanning(false)
      }
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
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close()
    }
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
    const relevant = entries.filter(
      (e) =>
        e &&
        e.identifier === "com.plexapp.plugins.library" &&
        positiveId(e.sectionID) === this.musicSectionId
    )
    if (relevant.length === 0) return

    for (const entry of relevant) {
      const id = positiveId(entry.itemID),
        type = Number(entry.type),
        state = Number(entry.state)
      if (
        !id ||
        ![8, 9, 10, 15].includes(type) ||
        ![0, 1, 5, 9].includes(state)
      )
        continue
      const key = `${type}:${id}`
      if (
        this.pendingChanges.size >= MAX_PENDING_CHANGES &&
        !this.pendingChanges.has(key)
      ) {
        this.catchUpPending = true
        continue
      }
      this.pendingChanges.set(key, { id, type, state } as CatalogueChange)
    }
    this.scheduleNotify()

    // Keep UI shelf refreshes quiet during scans, but never discard catalogue
    // hints: state 1 is also terminal when a library has no metadata agent.
    if (this._isScanning || this.notifyCatalogue) return

    const needsRefresh = relevant.some((e) =>
      [0, 1, 5, 9].includes(Number(e.state))
    )
    if (needsRefresh) {
      this.scheduleRefresh()
    }
  }

  private handleActivity(notifications: ActivityNotification[]) {
    for (const n of notifications) {
      if (n.Activity.type !== "library.update.section") continue

      if (n.event === "started") {
        this._isScanning = true
        this._lastProgressUpdate = this.clock.now()
        this.setScanning(true, n.Activity.progress)
      } else if (n.event === "updated") {
        this._isScanning = true
        // Throttle progress state updates to avoid overwhelming the webview
        const now = this.clock.now()
        if (now - this._lastProgressUpdate >= PROGRESS_THROTTLE_MS) {
          this._lastProgressUpdate = now
          this.setScanning(true, n.Activity.progress)
        }
      } else if (n.event === "ended") {
        this._isScanning = false
        this.setScanning(false)
        this.requestCatchUp()
        // Single refresh after scan completes — bypass cooldown
        if (!this.notifyCatalogue) this.scheduleRefresh(true)
      }
    }
  }

  /** Catch events missed before first connection, during an outage or overflow. */
  requestCatchUp() {
    if (this.intentionalClose || !this.notifyCatalogue) return
    this.catchUpPending = true
    this.scheduleNotify()
  }

  private scheduleNotify(delay = DEBOUNCE_MS) {
    if (
      !this.notifyCatalogue ||
      this.intentionalClose ||
      this.notifyTimer ||
      this.notifyInFlight ||
      (!this.pendingChanges.size && !this.catchUpPending)
    )
      return
    // Leading delay bounds bursts without a perpetual debounce during imports.
    this.notifyTimer = this.clock.setTimeout(() => {
      this.notifyTimer = null
      void this.flushCatalogue()
    }, delay)
  }

  private async flushCatalogue() {
    if (!this.notifyCatalogue || this.intentionalClose || this.notifyInFlight)
      return
    const generation = this.generation
    const changes = [...this.pendingChanges.values()].slice(
      0,
      NOTIFY_BATCH_SIZE
    )
    const catchUp = this.catchUpPending
    for (const change of changes)
      this.pendingChanges.delete(`${change.type}:${change.id}`)
    this.catchUpPending = false
    this.notifyInFlight = true
    let failed = false
    try {
      await this.notifyCatalogue(changes, catchUp)
    } catch {
      failed = true
      if (generation === this.generation && !this.intentionalClose) {
        for (const change of changes) {
          const key = `${change.type}:${change.id}`
          if (
            !this.pendingChanges.has(key) &&
            this.pendingChanges.size < MAX_PENDING_CHANGES
          )
            this.pendingChanges.set(key, change)
          else if (!this.pendingChanges.has(key)) this.catchUpPending = true
        }
        this.catchUpPending ||= catchUp
      }
    } finally {
      if (generation === this.generation && !this.intentionalClose) {
        this.notifyInFlight = false
        this.scheduleNotify(failed ? RECONNECT_BASE_MS : 0)
      }
    }
  }

  /**
   * Schedule a debounced refresh. If `bypassCooldown` is false (default),
   * the refresh is skipped when still within the cooldown window.
   */
  private scheduleRefresh(bypassCooldown = false) {
    // If we're within cooldown and not bypassing, skip entirely
    if (
      !bypassCooldown &&
      this.clock.now() - this._lastRefreshAt < REFRESH_COOLDOWN_MS
    ) {
      console.log("[PlexWS] Refresh skipped (cooldown)")
      return
    }

    // Cancel any pending debounce — the latest call wins
    if (this.debounceTimer) this.clock.clearTimeout(this.debounceTimer)

    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null
      this.doRefresh()
    }, DEBOUNCE_MS)
  }

  private doRefresh() {
    // Guard against overlapping refreshes
    if (this._refreshInFlight) return

    this._refreshInFlight = true
    this._lastRefreshAt = this.clock.now()
    const generation = this.generation

    const store = this.getStore()
    // Only invalidate TTL timestamps — do NOT nuke playlist/mix caches
    store.invalidateLibraryTTLs()

    console.log("[PlexWS] Refreshing library data")
    void store
      .refreshAll()
      .catch(() => {})
      .finally(() => {
        if (generation === this.generation) this._refreshInFlight = false
      })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS
    )
    this.reconnectAttempts++
    console.log(
      `[PlexWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    )
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null
      if (!this.intentionalClose) this.openSocket()
    }, delay)
  }

  private clearTimers() {
    if (this.reconnectTimer) {
      this.clock.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.debounceTimer) {
      this.clock.clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.notifyTimer) {
      this.clock.clearTimeout(this.notifyTimer)
      this.notifyTimer = null
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
