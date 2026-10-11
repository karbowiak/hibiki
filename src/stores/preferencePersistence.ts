import {
  applyStatePatches,
  appendStatePatches,
  isRecord,
  statePatches,
  type PatchRules,
  type SavedState,
  type StatePatch,
} from "./persistencePatches"

export interface PreferenceBackend {
  get(key: string): Promise<unknown> | unknown
  update(
    key: string,
    transform: (current: unknown) => string
  ): Promise<void> | void
  remove(key: string): Promise<void> | void
}
export interface PersistenceIssue {
  key: string
  operation: "read" | "write" | "remove"
  hasPendingChanges: boolean
}
interface Envelope {
  state: SavedState
  version?: number
  [key: string]: unknown
}
interface Entry {
  owner: symbol
  ready: boolean
  previous: SavedState
  pending: StatePatch[]
  writing: Promise<void> | null
  removing: Promise<void> | null
  deletePending: boolean
  readEpoch: number
  issue: PersistenceIssue | null
  retryHydration?: () => Promise<unknown> | unknown
  rules: PatchRules
  version: number
  validate?: (state: SavedState) => boolean
  hasPendingIntent?: () => boolean
}
export interface PreferenceSession {
  read(): Promise<Envelope | null>
  stage(state: SavedState): Promise<void>
  merge(saved: unknown): SavedState
  baseline(state: SavedState): void
  hydrated(error?: unknown): void
  remove(): Promise<void>
  setRetry(callback: () => Promise<unknown> | unknown): void
}

function decode(raw: unknown, entry: Entry): Envelope | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "string") throw new Error("Invalid saved preferences")
  const value = JSON.parse(raw)
  if (
    !isRecord(value) ||
    !isRecord(value.state) ||
    (value.version !== undefined && value.version !== entry.version) ||
    (entry.validate && !entry.validate(value.state))
  )
    throw new Error("Invalid saved preferences")
  return value as Envelope
}

/** Keeps failed writes, fences hydration, and changes IndexedDB records atomically. */
export class PreferencePersistence {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  private issues: PersistenceIssue[] = []
  subscribe = (callback: () => void) => {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  snapshot = () => this.issues
  private notify() {
    const issues = [...this.entries.values()].flatMap((entry) =>
      entry.issue
        ? [
            {
              ...entry.issue,
              hasPendingChanges:
                entry.issue.hasPendingChanges || entry.pending.length > 0,
            },
          ]
        : []
    )
    if (JSON.stringify(issues) === JSON.stringify(this.issues)) return
    this.issues = issues
    this.listeners.forEach((callback) => {
      try {
        callback()
      } catch {
        /* A subscriber cannot abort a state mutation. */
      }
    })
  }
  constructor(private backend: PreferenceBackend) {}

  register(
    key: string,
    rules: PatchRules = {},
    version = 0,
    validate?: (state: SavedState) => boolean,
    hasPendingIntent?: () => boolean
  ): PreferenceSession {
    const previous = this.entries.get(key)
    const owner = Symbol(key)
    const entry: Entry = {
      owner,
      ready: false,
      previous: {},
      pending: previous?.pending ?? [],
      writing: null,
      removing: null,
      deletePending: previous?.deletePending ?? false,
      readEpoch: 0,
      issue: previous?.issue ?? null,
      rules,
      version,
      validate,
      hasPendingIntent,
    }
    this.entries.set(key, entry)
    if (previous?.writing) {
      const inherited = previous.writing.then(() => {
        if (entry.writing === inherited) entry.writing = null
      })
      entry.writing = inherited
    }
    if (previous?.removing) {
      const inherited = previous.removing.then(() => {
        entry.deletePending = previous.deletePending
        entry.issue = previous.issue
        if (entry.removing === inherited) entry.removing = null
        this.notify()
      })
      entry.removing = inherited
    }
    const current = () => this.entries.get(key)?.owner === owner
    const check = () => {
      if (!current()) throw new Error("Preference hydration was superseded")
    }
    return {
      baseline: (state) => {
        if (current()) entry.previous = state
      },
      read: async () => {
        check()
        const epoch = ++entry.readEpoch
        entry.ready = false
        const checkRead = () => {
          check()
          if (epoch !== entry.readEpoch)
            throw new Error("Preference read was superseded")
        }
        try {
          // Read after accepted writes and clears, including a replaced owner.
          if (entry.writing) await entry.writing
          if (entry.removing) await entry.removing
          checkRead()
          if (entry.deletePending)
            throw new Error("Preference clear is pending")
          const raw = await this.backend.get(key)
          checkRead()
          return decode(raw, entry)
        } catch (error) {
          if (current() && epoch === entry.readEpoch && !entry.deletePending) {
            entry.issue = {
              key,
              operation: "read",
              hasPendingChanges: entry.pending.length > 0,
            }
            this.notify()
          }
          throw error
        }
      },
      stage: async (state) => {
        if (!current()) return
        try {
          const patches = statePatches(entry.previous, state, entry.rules)
          entry.previous = state
          appendStatePatches(entry.pending, patches)
          if (entry.issue && patches.length) this.notify()
          if (entry.ready && !entry.issue) await this.drain(key, entry)
        } catch {
          entry.issue = { key, operation: "write", hasPendingChanges: true }
          this.notify()
        }
      },
      merge: (saved) => {
        check()
        return applyStatePatches(isRecord(saved) ? saved : {}, entry.pending)
      },
      hydrated: (error) => {
        if (!current() || entry.deletePending) return
        if (error) {
          entry.ready = false
          entry.issue = {
            key,
            operation: "read",
            hasPendingChanges: entry.pending.length > 0,
          }
          this.notify()
          return
        }
        entry.ready = true
        entry.issue = null
        this.notify()
        void this.drain(key, entry)
      },
      remove: () => {
        if (!current()) return Promise.resolve()
        // Explicit clear supersedes prior reads and edits. Edits made after
        // this point stay queued until deletion finishes, even if it fails.
        if (!entry.deletePending) {
          ++entry.readEpoch
          entry.ready = false
          entry.pending.length = 0
          entry.deletePending = true
        }
        return this.remove(key, entry)
      },
      setRetry: (callback) => {
        if (current()) entry.retryHydration = callback
      },
    }
  }

  private drain(key: string, entry: Entry): Promise<void> {
    if (entry.writing) return entry.writing
    if (!entry.ready || entry.deletePending || !entry.pending.length)
      return Promise.resolve()
    const job = (async () => {
      while (
        this.entries.get(key) === entry &&
        entry.ready &&
        entry.pending.length
      ) {
        // Detach the accepted batch. New edits cannot coalesce into a batch
        // already being committed and then disappear when it completes.
        const patches = entry.pending.splice(0)
        try {
          await this.backend.update(key, (raw) => {
            const stored = decode(raw, entry)
            const state = applyStatePatches(stored?.state ?? {}, patches)
            if (entry.validate && !entry.validate(state))
              throw new Error("Invalid preference update")
            return JSON.stringify({ ...stored, state, version: entry.version })
          })
          entry.issue = null
        } catch {
          if (!entry.deletePending) {
            entry.pending.unshift(...patches)
            entry.issue = { key, operation: "write", hasPendingChanges: true }
          }
          break
        }
      }
    })()
    entry.writing = job
    void job.finally(() => {
      entry.writing = null
      if (this.entries.get(key) === entry) this.notify()
    })
    return job
  }

  private remove(key: string, entry: Entry): Promise<void> {
    if (entry.removing) return entry.removing
    const job = (async () => {
      // An already accepted transaction finishes before the deletion.
      if (entry.writing) await entry.writing
      try {
        await this.backend.remove(key)
        entry.deletePending = false
        entry.ready = true
        entry.issue = null
      } catch {
        entry.issue = {
          key,
          operation: "remove",
          hasPendingChanges: entry.pending.length > 0,
        }
      }
    })()
    entry.removing = job
    void job.finally(() => {
      entry.removing = null
      if (this.entries.get(key) === entry) {
        this.notify()
        if (!entry.deletePending) void this.drain(key, entry)
      }
    })
    return job
  }

  async retry(): Promise<void> {
    await Promise.all(
      [...this.entries]
        .filter(([, entry]) => entry.issue)
        .map(async ([key, entry]) => {
          try {
            if (entry.issue?.operation === "read")
              await entry.retryHydration?.()
            else if (entry.issue?.operation === "write")
              await this.drain(key, entry)
            else if (entry.issue?.operation === "remove")
              await this.remove(key, entry)
          } catch {
            /* The session retains its issue and changes for another retry. */
          }
        })
    )
  }
  /** Closing may proceed only after every accepted edit/delete is durable. */
  async flushForShutdown(): Promise<void> {
    await Promise.all([...this.entries].map(async ([, entry]) => {
      if (!entry.ready && (entry.pending.length || entry.hasPendingIntent?.())) {
        try { await entry.retryHydration?.() } catch { /* Retain changes for Retry. */ }
      }
    }))
    await this.flush()
    for (const [key, entry] of this.entries) {
      if (entry.pending.length || entry.deletePending || entry.hasPendingIntent?.()) {
        entry.issue = { ...(entry.issue ?? { key, operation: entry.ready ? "write" : "read" }), hasPendingChanges: entry.pending.length > 0 || !!entry.hasPendingIntent?.() }
        this.notify()
        throw new Error("Some preferences could not be saved. Retry before closing Hibiki.")
      }
    }
  }
  async flush(): Promise<void> {
    await Promise.all(
      [...this.entries].map(async ([key, entry]) => {
        if (entry.removing) await entry.removing
        if (entry.writing) await entry.writing
        if (entry.ready && entry.pending.length) await this.drain(key, entry)
      })
    )
  }
}
