import type { Call, Domain } from "./actions"
export interface ProviderDescription {
  data: Record<string, unknown>
  methods: string[]
  favorites?: string[]
}
export interface WorkerContext {
  owner: string
  provider: ProviderDescription | null
  youtube: { connected: boolean; accountId?: string | null; revision: number }
  lastfm: {
    isAuthenticated: boolean
    isEnabled: boolean
    username: string | null
  }
  listenbrainz: {
    isAuthenticated: boolean
    isEnabled: boolean
    username: string | null
  }
}
export type Job = { token: string; request: Call & { owner: string } }
export type Progress = {
  stage: string
  current?: string | null
  completed: number
  total?: number | null
  unit: string
}
export type ToWorker =
  | { type: "context"; context: WorkerContext }
  | { type: "state"; owner: string; domain: Domain; data: any }
  | { type: "run"; job: Job }
  | { type: "reply"; id: number; value?: any; error?: string }
  | { type: "callback"; id: number; value: any }
export type FromWorker =
  | { type: "ready" }
  | { type: "mutated"; token: string }
  | {
      type: "rpc"
      id: number
      owner: string
      kind: "invoke" | "provider"
      method: string
      args: any
    }
  | { type: "state"; owner: string; domain: Domain; data: any }
  | { type: "progress"; token: string; progress: Progress }
  | {
      type: "finished"
      token: string
      result?: any
      error?: string
      unexpected?: boolean
    }
  | { type: "fault"; message: string }

/** Share admission/IPC for identical concurrent calls, never completed mutation
 * results. Ownership and the complete request arguments are part of the key. */
export class PendingCalls {
  private calls = new Map<string, Promise<unknown>>()
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const active = this.calls.get(key)
    if (active) return active as Promise<T>
    const pending = Promise.resolve().then(work).finally(() => {
      if (this.calls.get(key) === pending) this.calls.delete(key)
    })
    this.calls.set(key, pending)
    return pending
  }
}

/** Preserve structured-clone types but exclude executable/provider references. */
export function workerData(value: any): any {
  if (typeof value === "function" || typeof value === "symbol") return undefined
  if (value === null || typeof value !== "object") return value
  if (value instanceof Set) return new Set([...value].map(workerData))
  if (value instanceof Map)
    return new Map([...value].map(([key, value]) => [key, workerData(value)]))
  if (Array.isArray(value)) return value.map(workerData)
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "provider" && key !== "session")
      .map(([key, value]) => [key, workerData(value)])
      .filter(([, value]) => value !== undefined)
  )
}

/** Compare immutable store fields before cloning. A progress-only change must
 * not walk or transfer an unchanged library. Keep one baseline per domain. */
export class StateSnapshots {
  private previous = new Map<Domain, Record<string, any>>()

  clear() {
    this.previous.clear()
  }

  take(domain: Domain, state: Record<string, any>) {
    const before = this.previous.get(domain)
    const patch: Record<string, any> = {}
    for (const [key, value] of Object.entries(state)) {
      if (
        key === "provider" ||
        key === "session" ||
        (domain === "favorites" && key === "syncRequest") ||
        typeof value === "function"
      )
        continue
      if (!before || !Object.is(before[key], value))
        patch[key] = workerData(value)
    }
    this.previous.set(domain, state)
    return Object.keys(patch).length ? patch : undefined
  }

  /** A received patch needn't be echoed. Preserve any unsent local changes
   * that were already present before applying it, including newer revisions. */
  received(
    domain: Domain,
    before: Record<string, any>,
    after: Record<string, any>
  ) {
    const baseline = this.previous.get(domain)
    if (!baseline) {
      this.previous.set(domain, after)
      return
    }
    const next = { ...baseline }
    for (const key of Object.keys(after))
      if (Object.is(baseline[key], before[key])) next[key] = after[key]
    this.previous.set(domain, next)
  }
}

/** Never let a delayed worker publication replace a newer local journal row. */
export function newestRows<T extends { id: string; revision?: number }>(
  before: T[],
  after: T[]
) {
  const previous = new Map(before.map((row) => [row.id, row]))
  const incoming = new Set(after.map((row) => row.id))
  return after
    .map((row) => {
      const current = previous.get(row.id)
      return current && (current.revision ?? 0) > (row.revision ?? 0)
        ? current
        : row
    })
    .concat(before.filter((row) => !incoming.has(row.id)))
}

/** Exact rating intentions use a new ID and timestamp for every local edit. */
export function newestRatings(
  before: Record<string, any>,
  after: Record<string, any>
) {
  const next = { ...before }
  for (const [key, entry] of Object.entries(after)) {
    const current = before[key]
    if (!current || current.changedAt < entry.changedAt) next[key] = entry
    else if (current.id === entry.id)
      next[key] = { ...entry, saved: { ...current.saved, ...entry.saved } }
  }
  return next
}
