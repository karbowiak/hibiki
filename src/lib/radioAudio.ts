/** Streaming radio uses the media element's decoder and Web Audio gain control. */
import { PlaybackGain, PLAYBACK_FADE_SECONDS } from "../audio/PlaybackGain"

export interface RadioAudioCallbacks {
  onPlaying?: () => void
  onWaiting?: () => void
  onError?: (msg: string) => void
  onPause?: () => void
  onStop?: () => void
}

export function radioVolumeGain(volume: number): number {
  return Number.isFinite(volume) ? Math.pow(Math.max(0, Math.min(100, volume)) / 100, 3) : 0
}

interface RadioTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (id: unknown) => void
}

const timers: RadioTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: id => clearTimeout(id as ReturnType<typeof setTimeout>),
}

/** Owns one station's element, audio graph, listeners and pending controls. */
export class RadioAudioPlayer {
  private master: GainNode
  private playback: GainNode
  private source: MediaElementAudioSourceNode
  private envelope: PlaybackGain
  private subscribers = new Set<RadioAudioCallbacks>()
  private disposers: (() => void)[] = []
  private pauseTimer: unknown = null
  private revision = 0
  private wantsPlaying = false
  private waiting = true
  private closed = false
  private error: string | null = null
  private internalPauses = 0

  constructor(private audio: HTMLAudioElement, private context: AudioContext, private clock: RadioTimers = timers) {
    this.audio.crossOrigin = "anonymous"
    this.audio.volume = 1
    this.source = context.createMediaElementSource(audio)
    this.master = context.createGain()
    this.playback = context.createGain()
    this.envelope = new PlaybackGain(this.playback.gain, context)
    this.source.connect(this.master)
    this.master.connect(this.playback)
    this.playback.connect(context.destination)
    this.on("playing", () => {
      if (!this.wantsPlaying || this.closed) {
        this.envelope.silence()
        this.pauseElement()
        return
      }
      this.waiting = false
      this.envelope.fadeTo(1)
      this.notify(cb => cb.onPlaying?.())
    })
    this.on("waiting", () => {
      this.waiting = true
      this.envelope.silence()
      if (this.wantsPlaying) this.notify(cb => cb.onWaiting?.())
    })
    this.on("error", () => this.fail("Could not play this radio stream. Check the station or your connection."))
    this.on("pause", () => {
      if (this.internalPauses > 0) {
        this.internalPauses--
        if (!this.wantsPlaying) this.notify(cb => cb.onPause?.())
        return
      }
      // A queued pause event from an earlier toggle must not undo a resume.
      if (!this.audio.paused) return
      this.wantsPlaying = false
      this.revision++
      this.clearPauseTimer()
      this.envelope.silence()
      this.notify(cb => cb.onPause?.())
    })
  }

  private on(name: string, handler: () => void): void {
    const guarded = () => { if (!this.closed) handler() }
    this.audio.addEventListener(name, guarded)
    this.disposers.push(() => this.audio.removeEventListener(name, guarded))
  }

  private notify(action: (cb: RadioAudioCallbacks) => void): void {
    if (!this.closed) for (const cb of this.subscribers) action(cb)
  }

  subscribe(cb: RadioAudioCallbacks): () => void {
    if (this.closed) return () => {}
    this.subscribers.add(cb)
    if (this.error) cb.onError?.(this.error)
    else if (this.wantsPlaying && this.waiting) cb.onWaiting?.()
    else if (this.wantsPlaying && !this.audio.paused) cb.onPlaying?.()
    return () => { this.subscribers.delete(cb) }
  }

  start(url: string, volume: number): void {
    try {
      if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("unsupported radio URL")
      this.audio.src = url
      this.setVolume(volume)
      this.resume()
    } catch {
      this.fail("This station does not have a valid HTTP or HTTPS stream.")
    }
  }

  setVolume(volume: number): void {
    if (!this.closed) this.master.gain.value = radioVolumeGain(volume)
  }

  pause(): void {
    if (this.closed || !this.wantsPlaying) return
    this.wantsPlaying = false
    const revision = ++this.revision
    this.clearPauseTimer()
    this.envelope.fadeTo(0)
    this.pauseTimer = this.clock.set(() => {
      if (this.closed || revision !== this.revision) return
      this.pauseTimer = null
      if (!this.wantsPlaying) this.pauseElement()
    }, PLAYBACK_FADE_SECONDS * 1000)
  }

  resume(): void {
    if (this.closed) return
    this.wantsPlaying = true
    this.error = null
    const revision = ++this.revision
    this.clearPauseTimer()
    // Reversing an audible pause tail does not need another playing event.
    if (!this.audio.paused && !this.waiting) {
      this.envelope.fadeTo(1)
      this.notify(cb => cb.onPlaying?.())
    } else {
      this.notify(cb => cb.onWaiting?.())
    }
    void this.context.resume().then(() => {
      if (this.closed || !this.wantsPlaying || revision !== this.revision) return
      return this.audio.play()
    }).catch(() => {
      if (!this.closed && this.wantsPlaying && revision === this.revision) {
        this.fail("Could not start this radio stream. Try playing it again.")
      }
    })
  }

  private fail(message: string): void {
    if (this.closed) return
    this.error = message
    this.wantsPlaying = false
    this.revision++
    this.clearPauseTimer()
    this.envelope.silence()
    this.pauseElement()
    this.notify(cb => cb.onError?.(message))
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer !== null) this.clock.clear(this.pauseTimer)
    this.pauseTimer = null
  }

  private pauseElement(): void {
    if (!this.audio.paused) this.internalPauses++
    this.audio.pause()
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    this.revision++
    this.clearPauseTimer()
    this.envelope.silence()
    const subscribers = [...this.subscribers]
    this.subscribers.clear()
    for (const cb of subscribers) cb.onStop?.()
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.audio.pause()
    this.audio.removeAttribute("src")
    this.audio.load()
    this.source.disconnect()
    this.master.disconnect()
    this.playback.disconnect()
    void this.context.close().catch(() => {})
  }
}

let player: RadioAudioPlayer | null = null
let startupError: string | null = null

export function radioPlay(url: string, volume: number): void {
  radioStop()
  let context: AudioContext | null = null
  try {
    context = new AudioContext()
    player = new RadioAudioPlayer(new Audio(), context)
    player.start(url, volume)
  } catch {
    void context?.close().catch(() => {})
    startupError = "Could not initialize radio audio. Try playing the station again."
  }
}

export function radioPause(): void { player?.pause() }
export function radioResume(): void { player?.resume() }
export function radioSetVolume(volume: number): void { player?.setVolume(volume) }

export function radioStop(): void {
  const previous = player
  player = null
  startupError = null
  previous?.stop()
}

export function radioOnEvents(cb: RadioAudioCallbacks): () => void {
  if (startupError) cb.onError?.(startupError)
  return player?.subscribe(cb) ?? (() => {})
}
