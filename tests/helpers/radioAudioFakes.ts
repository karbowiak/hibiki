export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

export class FakeAudio extends EventTarget {
  src = ""
  volume = 1
  crossOrigin = ""
  paused = true
  playCalls = 0
  loadCalls = 0
  playResult: Promise<void> = Promise.resolve()
  queued: (() => void)[] = []
  listeners = new Set<EventListenerOrEventListenerObject>()

  override addEventListener(name: string, handler: EventListenerOrEventListenerObject) {
    this.listeners.add(handler)
    super.addEventListener(name, handler)
  }
  override removeEventListener(name: string, handler: EventListenerOrEventListenerObject) {
    this.listeners.delete(handler)
    super.removeEventListener(name, handler)
  }
  emit(name: string) { this.dispatchEvent(new Event(name)) }
  play() { this.playCalls++; this.paused = false; return this.playResult }
  pause() {
    if (this.paused) return
    this.paused = true
    // HTML media events are queued, not delivered synchronously by pause().
    this.queued.push(() => this.emit("pause"))
  }
  flushEvents() { for (const fn of this.queued.splice(0)) fn() }
  removeAttribute(name: string) { if (name === "src") this.src = "" }
  load() { this.loadCalls++ }
}

export class FakeParam {
  value = 1
  curves: { values: Float32Array; time: number; duration: number }[] = []
  values: { value: number; time: number }[] = []
  cancelled: number[] = []
  cancelScheduledValues(time: number) { this.cancelled.push(time); return this }
  setValueAtTime(value: number, time: number) { this.values.push({ value, time }); return this }
  setValueCurveAtTime(values: Float32Array, time: number, duration: number) {
    this.curves.push({ values: values.slice(), time, duration })
    return this
  }
}

export class FakeNode {
  gain = new FakeParam()
  connections: unknown[] = []
  disconnectCalls = 0
  connect(node: unknown) { this.connections.push(node); return node }
  disconnect() { this.disconnectCalls++; this.connections = [] }
}

export class FakeContext {
  currentTime = 0
  source = new FakeNode()
  gains: FakeNode[] = []
  destination = {}
  closeCalls = 0
  resumeResult: Promise<void> = Promise.resolve()
  createMediaElementSource() { return this.source }
  createGain() { const node = new FakeNode(); this.gains.push(node); return node }
  resume() { return this.resumeResult }
  close() { this.closeCalls++; return Promise.resolve() }
}

export class FakeTimers {
  now = 0
  nextId = 0
  pending = new Map<number, { due: number; fn: () => void }>()
  archive: (() => void)[] = []
  constructor(private context: FakeContext) {}
  set = (fn: () => void, ms: number) => {
    const id = ++this.nextId
    this.pending.set(id, { due: this.now + ms, fn })
    this.archive.push(fn)
    return id
  }
  clear = (id: unknown) => { this.pending.delete(id as number) }
  advance(ms: number) {
    this.now += ms
    this.context.currentTime = this.now / 1000
    for (const [id, timer] of [...this.pending]) {
      if (timer.due > this.now) continue
      this.pending.delete(id)
      timer.fn()
    }
  }
}
