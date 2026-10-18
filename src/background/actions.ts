import { isTauri } from "@tauri-apps/api/core"
import type { StoreApi } from "zustand"
import { trackBackgroundCall } from "./status"

export type Domain =
  "mixed" | "linked" | "favorites" | "ratings" | "collections" | "metadata"
export type Call = {
  domain: Domain
  method: string
  args: unknown[]
  onMutation?: () => void
}
type Entry = {
  store: StoreApi<any>
  methods: Record<string, (...args: any[]) => any>
}
export const backgroundDomains = new Map<Domain, Entry>()
let dispatcher: ((call: Call) => Promise<unknown>) | undefined
export function setBackgroundDispatcher(next: typeof dispatcher) {
  dispatcher = next
}
export function backgroundCall(call: Call) {
  return dispatcher?.(call)
}
export const inBackgroundWorker = () =>
  !!(globalThis as any).__HIBIKI_BACKGROUND_WORKER__

/** Only replay-safe reconciliation entry points, never arbitrary UI mutations.
 * Receipts stay in the existing domain journals, with their revision checks. */
export function backgroundActions<S>(
  domain: Domain,
  store: StoreApi<S>,
  names: (keyof S & string)[]
) {
  const methods = Object.fromEntries(
    names.map((name) => [name, store.getState()[name]])
  ) as Entry["methods"]
  backgroundDomains.set(domain, { store, methods })
  if (inBackgroundWorker() || !isTauri()) return
  const patch: Record<string, unknown> = {}
  for (const method of names)
    patch[method] = (...args: unknown[]) => {
      if (!dispatcher) return methods[method](...args)
      // Carry changed identities, but rebuild the uncloneable provider reference
      // in the worker. This also preserves invalidation for removed recordings.
      if (
        (method === "retryIndexedMatches" || method === "retryPlexMatches") &&
        args[0]
      )
        args = [{ ...(args[0] as object), provider: undefined }]
      let onMutation: (() => void) | undefined
      if (domain === "linked") {
        onMutation = (args[2] as { onMutation?: () => void } | undefined)
          ?.onMutation
        if (typeof args[1] === "function") args[1] = undefined
        if (args[2]) args[2] = { ...(args[2] as object), onMutation: undefined }
      }
      const admitted = dispatcher
      const id = ["mixed", "linked"].includes(domain) && typeof args[0] === "string" ? args[0] : undefined
      return trackBackgroundCall(domain, id, () => admitted({ domain, method, args, onMutation }))
    }
  store.setState(patch as Partial<S>)
}
