import { useEffect, useRef } from "react"
import { useEasterEggStore } from "../stores/easterEggStore"
import { useAccentStore, applyAccent } from "../stores/accentStore"
import { useVisualizerStore } from "../stores/visualizerStore"

const UNLOCK_TRIGGER = "itseasterbunny"

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

export function useEasterEggs() {
  const bufRef = useRef("")

  // Keystroke detection: typing "itseasterbunny" unlocks the easter eggs section
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return
      if (e.key.length !== 1) return
      bufRef.current = (bufRef.current + e.key.toLowerCase()).slice(-UNLOCK_TRIGGER.length)
      if (bufRef.current === UNLOCK_TRIGGER) {
        useEasterEggStore.getState().unlock()
        bufRef.current = ""
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Rainbow mode: cycle --accent / --accent-rgb CSS variables
  const rainbow = useEasterEggStore(s => s.rainbow)
  const vaporwave = useEasterEggStore(s => s.vaporwave)

  useEffect(() => {
    // Vaporwave takes precedence over rainbow for accent cycling
    if (!rainbow || vaporwave) {
      if (!vaporwave) applyAccent(useAccentStore.getState().accent)
      return
    }
    let raf: number
    const loop = () => {
      const hue = (performance.now() / 50) % 360
      const [r, g, b] = hslToRgb(hue, 80, 60)
      document.documentElement.style.setProperty("--accent", `hsl(${hue}, 80%, 60%)`)
      document.documentElement.style.setProperty("--accent-rgb", `${r} ${g} ${b}`)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [rainbow, vaporwave])

  // Vaporwave mode: add class + override CSS variables
  useEffect(() => {
    if (vaporwave) {
      document.documentElement.classList.add("vaporwave")
    } else {
      document.documentElement.classList.remove("vaporwave")
      // Restore original accent when turning off vaporwave
      applyAccent(useAccentStore.getState().accent)
    }
    return () => {
      document.documentElement.classList.remove("vaporwave")
    }
  }, [vaporwave])

  // Party mode: beat-reactive pulse
  const partyMode = useEasterEggStore(s => s.partyMode)

  useEffect(() => {
    if (partyMode) {
      document.documentElement.classList.add("party-mode")
    } else {
      document.documentElement.classList.remove("party-mode")
      document.documentElement.style.setProperty("--party-pulse", "0")
    }

    if (!partyMode) return

    // Two-EMA beat detection: a fast EMA tracks transients, a slow EMA
    // tracks the long-term energy floor. A beat fires when fast > slow * ratio.
    let fastEma = 0
    let slowEma = 0
    let cooldown = 0 // frames to wait after a beat before allowing the next
    let raf: number
    let lastTick = 0
    const loop = (now: number) => {
      if (now - lastTick >= 50) { // ~20fps throttle
        lastTick = now
        const samples = useVisualizerStore.getState().getRecentSamples(2048)
        let sum = 0
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
        const rms = Math.sqrt(sum / samples.length)

        // Fast EMA reacts quickly to transients, slow EMA tracks baseline
        fastEma = fastEma * 0.6 + rms * 0.4
        slowEma = slowEma * 0.97 + rms * 0.03

        if (cooldown > 0) cooldown--

        // Beat fires when fast energy spikes above the slow baseline
        const isBeat = cooldown === 0 && fastEma > Math.max(slowEma * 1.3, 0.008)
        if (isBeat) cooldown = 4 // ~200ms minimum gap between beats at 20fps

        const current = parseFloat(document.documentElement.style.getPropertyValue("--party-pulse") || "0")
        const next = isBeat ? 1 : current * 0.7
        document.documentElement.style.setProperty("--party-pulse", String(next < 0.01 ? 0 : next))
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      document.documentElement.classList.remove("party-mode")
      document.documentElement.style.setProperty("--party-pulse", "0")
    }
  }, [partyMode])
}
