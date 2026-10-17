import type { StateStorage } from "zustand/middleware"

/** Cached provider data is never hydrated before its account/library is known. */
export class ScopedPersistence {
  private scope: string | null = null
  private epoch = 0
  private ready = false
  private previous: Record<string, unknown> | null = null
  private pending = new Map<
    string,
    { scope: string; state: Record<string, unknown> }
  >()
  private writing: Promise<void> | null = null

  constructor(
    private storage: StateStorage | undefined,
    private namespace: string
  ) {}

  async activate(scope: string | null): Promise<unknown> {
    const epoch = ++this.epoch
    this.scope = scope
    this.ready = false
    this.previous = null
    if (!scope || !this.storage) return
    // A quick reconnect must read the latest queued snapshot, not an older one.
    await this.flush()
    if (epoch !== this.epoch) return
    try {
      const raw = await this.storage.getItem(`${this.namespace}:${scope}`)
      if (epoch !== this.epoch) return
      this.ready = true
      if (!raw) return
      const saved = JSON.parse(raw)
      if (saved?.version === 2 && saved.scope === scope) return saved.state
    } catch {
      if (epoch === this.epoch) this.ready = true
      // Storage failure must not prevent online playback.
    }
  }

  cancelHydration() {
    ++this.epoch
    this.ready = !!this.scope && !!this.storage
    this.previous = null
  }

  save(state: Record<string, unknown>) {
    if (!this.scope || !this.storage || !this.ready) return
    if (
      this.previous &&
      Object.keys(state).length === Object.keys(this.previous).length &&
      Object.keys(state).every((key) => state[key] === this.previous![key])
    )
      return
    this.previous = state
    // Coalesce immutable snapshots before paying the serialization cost.
    this.pending.set(`${this.namespace}:${this.scope}`, {
      scope: this.scope,
      state,
    })
    this.drain()
  }

  private drain() {
    if (this.writing || !this.storage) return
    this.writing = (async () => {
      while (this.pending.size) {
        const [key, snapshot] = this.pending.entries().next().value!
        this.pending.delete(key)
        try {
          const value = JSON.stringify({ version: 2, ...snapshot })
          await this.storage!.setItem(key, value)
        } catch {
          // Permit another save of the same snapshot after an optional write fails.
          if (this.scope === snapshot.scope && this.previous === snapshot.state)
            this.previous = null
        }
      }
    })().finally(() => {
      this.writing = null
      if (this.pending.size) this.drain()
    })
  }

  async flush() {
    while (this.writing || this.pending.size) {
      if (!this.writing) this.drain()
      await this.writing
    }
  }
}
