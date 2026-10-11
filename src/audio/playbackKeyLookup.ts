/** Keep reverse identities only while playback owns them or they remain recent. */
export class PlaybackKeyLookup {
  private entries = new Map<number, string>()
  private idBytes = 0
  constructor(
    private protectedKeys: () => ReadonlySet<number> = () => new Set(),
    private maxEntries = 256,
    private maxIdBytes = 1024 * 1024,
  ) {}
  get size(): number { return this.entries.size }
  get estimatedIdBytes(): number { return this.idBytes }
  get(key: number): string | undefined {
    const id = this.entries.get(key)
    if (id !== undefined) { this.entries.delete(key); this.entries.set(key, id) }
    return id
  }
  set(key: number, id: string): void {
    this.remove(key)
    // Plex maps these IDs with String(rating_key); the numeric fallback is exact.
    if (Number.isSafeInteger(key) && key > 0 && id === String(key)) { this.trim(); return }
    this.entries.set(key, id)
    this.idBytes += id.length * 2 // conservative UTF16 storage estimate
    this.trim()
  }
  trim(): void {
    const protectedKeys = this.protectedKeys()
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.idBytes <= this.maxIdBytes) break
      // Owned identities may exceed the byte budget; their queue/journal already
      // retains those same strings. Never break native ownership to evict them.
      if (protectedKeys.has(key)) continue
      this.remove(key)
    }
  }
  clearUnowned(): void {
    const protectedKeys = this.protectedKeys()
    for (const key of this.entries.keys()) if (!protectedKeys.has(key)) this.remove(key)
  }
  private remove(key: number): void {
    const id = this.entries.get(key)
    if (id !== undefined) { this.idBytes -= id.length * 2; this.entries.delete(key) }
  }
}
