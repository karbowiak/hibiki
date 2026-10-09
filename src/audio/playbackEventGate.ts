/** Events can arrive before invoke returns its native request ID. Buffer that
 * short interval, then deliver only events owned by the confirmed request. */
export class PlaybackEventGate {
  private ticket = 0
  private requestId: number | null = 0
  private disabled = false
  private pending: { requestId: number; deliver: () => void }[] = []

  begin(): number {
    this.disabled = false
    this.requestId = null
    this.pending = []
    return ++this.ticket
  }

  confirm(ticket: number, requestId: number): void {
    if (ticket !== this.ticket || this.disabled) return
    this.requestId = requestId
    const pending = this.pending
    this.pending = []
    for (const event of pending) {
      // A callback can synchronously start the next selection.
      if (ticket !== this.ticket) break
      if (event.requestId === requestId) event.deliver()
    }
  }

  accept(requestId: number, deliver: () => void): void {
    if (this.disabled) return
    if (this.requestId === null) {
      this.pending.push({ requestId, deliver })
      if (this.pending.length > 32) this.pending.shift()
    } else if (requestId === this.requestId) {
      deliver()
    }
  }

  disable(): void {
    ++this.ticket
    this.disabled = true
    this.pending = []
  }
}
