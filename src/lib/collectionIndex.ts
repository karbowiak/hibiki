/** One owned, shared index. Full metadata belongs to the visible page window. */
export class CollectionIndex<T> {
  private value = { items: [] as T[], ready: false, error: "", at: 0 }
  private listeners = new Set<() => void>()
  private epoch = 0
  private pending: Promise<void> | undefined
  private scheduled = false
  constructor(
    private load: () => Promise<T[]>,
    private owns: () => boolean
  ) {}
  snapshot = () => this.value
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(patch: Partial<typeof this.value>) {
    this.value = { ...this.value, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  read = () => {
    if (
      this.pending ||
      !this.owns() ||
      (this.value.ready && Date.now() - this.value.at < 300_000)
    )
      return
    const epoch = this.epoch
    const request = this.load()
      .then((items) => {
        if (epoch === this.epoch && this.owns())
          this.publish({ items, ready: true, error: "", at: Date.now() })
      })
      .catch(() => {
        if (epoch === this.epoch && this.owns())
          this.publish({
            error: "Could not refresh this collection. Try again.",
          })
      })
      .finally(() => {
        if (this.pending === request) this.pending = undefined
      })
    this.pending = request
  }
  retry = () => {
    if (this.scheduled) return
    this.epoch++
    this.pending = undefined
    this.scheduled = true
    this.publish({ at: 0, error: "" })
    queueMicrotask(() => {
      this.scheduled = false
      if (this.listeners.size) this.read()
    })
  }
}
