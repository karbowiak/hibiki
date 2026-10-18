import { create } from "zustand"
import type { Domain } from "./actions"

/** Renderer admission is visible immediately, before Butler claims the job or
 * its worker can publish running state. Counts handle coalesced callers. */
export const useBackgroundCallStore = create<{ pending: Record<string, number> }>(() => ({ pending: {} }))
export async function trackBackgroundCall<T>(domain: Domain, id: string | undefined, work: () => Promise<T>): Promise<T> {
  if (!id) return work()
  const key = `${domain}:${id}`
  useBackgroundCallStore.setState(state => ({ pending: { ...state.pending, [key]: (state.pending[key] ?? 0) + 1 } }))
  try { return await work() }
  finally {
    useBackgroundCallStore.setState(state => {
      const pending = { ...state.pending }, count = (pending[key] ?? 1) - 1
      if (count) pending[key] = count
      else delete pending[key]
      return { pending }
    })
  }
}
