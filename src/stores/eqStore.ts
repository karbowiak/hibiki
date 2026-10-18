import { create } from "zustand"
import { persist } from "zustand/middleware"
import { engine } from "../audio/RustAudioEngine"
import { correctionProfile } from "../audio/deviceCorrection"
import { createOutputEqState, type OutputEqState } from "./outputEqState"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EQ_LABELS = [
  "32",
  "64",
  "125",
  "250",
  "500",
  "1K",
  "2K",
  "4K",
  "8K",
  "16K",
]

export type EqGains = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

const FLAT: EqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

export const EQ_PRESETS: { name: string; gains: EqGains }[] = [
  { name: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Bass Boost", gains: [8, 6, 4, 2, 0, 0, 0, 0, 0, 0] },
  { name: "Treble Boost", gains: [0, 0, 0, 0, 0, 0, 2, 4, 6, 8] },
  { name: "Vocal", gains: [-2, -2, 0, 3, 5, 5, 3, 0, -2, -2] },
  { name: "Electronic", gains: [7, 5, 0, 0, -3, -2, 0, 4, 6, 7] },
  { name: "Rock", gains: [5, 4, 3, 1, -1, -1, 0, 3, 4, 5] },
  { name: "Classical", gains: [0, 0, 0, 0, 0, 0, -2, -3, -3, -4] },
]

// ---------------------------------------------------------------------------
// Device Profile
// ---------------------------------------------------------------------------

export interface EqProfile {
  gains: EqGains
  enabled: boolean
  postgainDb: number
  autoPostgain: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validGains(value: unknown): value is EqGains {
  return (
    Array.isArray(value) &&
    value.length === 10 &&
    value.every((gain) => typeof gain === "number" && Number.isFinite(gain))
  )
}
function clampGains(gains: EqGains): EqGains {
  return gains.map((gain) => Math.max(-12, Math.min(12, gain))) as EqGains
}
function profileForDevice(
  profiles: Record<string, EqProfile>,
  name: string
): EqProfile | undefined {
  return profiles && Object.hasOwn(profiles, name) ? profiles[name] : undefined
}
function validProfile(profile: EqProfile): boolean {
  return (
    !!profile &&
    validGains(profile.gains) &&
    typeof profile.enabled === "boolean" &&
    typeof profile.autoPostgain === "boolean" &&
    (profile.autoPostgain || Number.isFinite(profile.postgainDb))
  )
}
function clearedProfileNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name) => typeof name === "string")
    : []
}
let configurationRevision = 0
function applyConfiguration(
  get: () => EqState,
  set: (patch: Partial<EqState>) => void,
  duck = false
) {
  const revision = ++configurationRevision
  const { gains, enabled, autoPostgain, postgainDb } = get()
  if (
    !validGains(gains) ||
    typeof enabled !== "boolean" ||
    typeof autoPostgain !== "boolean" ||
    (!autoPostgain &&
      (typeof postgainDb !== "number" || !Number.isFinite(postgainDb)))
  ) {
    set({
      applying: false,
      eqError: "The saved equalizer settings are invalid.",
    })
    return
  }
  const normalized = clampGains(gains)
  set({ gains: normalized, applying: true, eqError: null })
  const output = get().currentOutput
  if (!output && get().outputIdentityKnown) {
    set({ applying: false, appliedEq: null, appliedOutputKey: null }); return
  }
  if (output) {
    if (!output.available) { set({ applying: false, appliedEq: null, appliedOutputKey: null }); return }
    let correction = null
    try {
      const selected = get().correctionPreview ?? (get().correctionEnabled && get().selectedCorrectionId
        ? get().corrections[get().selectedCorrectionId!] : null)
      if (get().correctionEnabled && get().selectedCorrectionId && !selected) throw Error("The selected correction is unavailable.")
      correction = selected ? correctionProfile(selected) : null
    } catch (error) { set({ applying: false, eqError: String(error) }); return }
    void engine.configureEqScene({ gainsDb: normalized, enabled, postgainDb: autoPostgain ? null : postgainDb,
      outputKey: output.key, correction }).then(result => {
      if (revision !== configurationRevision || get().currentOutput?.key !== output.key) return
      if (!result || !Number.isFinite(result.tonePostgainDb)) throw Error("Invalid EQ response")
      set({ applying: false, postgainDb: result.tonePostgainDb, appliedEq: result, appliedOutputKey: output.key })
    }).catch(error => {
      if (revision === configurationRevision) set({ applying: false, appliedEq: null, appliedOutputKey: null,
        eqError: typeof error === "string" ? error : "Couldn’t apply the output settings. Try again." })
    })
    return
  }
  void engine
    .configureEq({
      gainsDb: normalized,
      enabled,
      postgainDb: autoPostgain ? null : postgainDb,
      duckMs: duck ? 30 : 0,
    })
    .then((appliedGain) => {
      if (revision !== configurationRevision) return
      if (typeof appliedGain !== "number" || !Number.isFinite(appliedGain))
        throw new Error("Invalid EQ response")
      set({ applying: false, postgainDb: appliedGain })
    })
    .catch(() => {
      if (revision === configurationRevision) {
        set({
          applying: false,
          eqError: "Couldn’t apply the equalizer settings. Try again.",
        })
      }
    })
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface EqState extends OutputEqState {
  // Core EQ
  gains: EqGains
  enabled: boolean
  // Postgain (makeup gain)
  postgainDb: number
  autoPostgain: boolean
  applying: boolean
  eqError: string | null
  // Device profiles
  deviceProfiles: Record<string, EqProfile>
  /** Explicit removals remain removed until the user saves that device again. */
  clearedDeviceProfiles: string[]
  currentDevice: string

  // Core EQ actions
  setBand: (index: number, db: number) => void
  setEnabled: (enabled: boolean) => void
  applyPreset: (preset: EqGains) => void
  syncToEngine: () => void

  // Postgain actions
  setPostgainDb: (db: number) => void
  setAutoPostgain: (auto: boolean) => void

  // Device profile actions
  setCurrentDevice: (name: string) => void
  saveProfileForDevice: (deviceName: string) => void
  deleteProfileForDevice: (deviceName: string) => void
  loadProfileForDevice: (deviceName: string) => void
}

export const useEqStore = create<EqState>()(
  persist(
    (set, get) => ({
      ...createOutputEqState(set, get, () => applyConfiguration(get, set), () => { ++configurationRevision }),
      gains: [...FLAT] as EqGains,
      enabled: false,
      postgainDb: 0,
      autoPostgain: false,
      applying: false,
      eqError: null,
      deviceProfiles: {},
      clearedDeviceProfiles: [],
      currentDevice: "",

      setBand: (index, db) => {
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= 10 ||
          !Number.isFinite(db)
        )
          return
        if (!validGains(get().gains)) return
        const next = [...get().gains] as EqGains
        next[index] = Math.max(-12, Math.min(12, db))
        set({ gains: next })
        applyConfiguration(get, set)
      },

      setEnabled: (enabled) => {
        set({ enabled })
        applyConfiguration(get, set)
      },

      applyPreset: (preset) => {
        if (!validGains(preset)) return
        // Presets change tone only; level compensation is an explicit opt-in.
        set({ gains: clampGains(preset), autoPostgain: false, postgainDb: 0 })
        applyConfiguration(get, set)
      },

      syncToEngine: () => applyConfiguration(get, set),

      setPostgainDb: (db) => {
        if (!Number.isFinite(db)) return
        set({
          postgainDb: Math.max(-24, Math.min(24, db)),
          autoPostgain: false,
        })
        applyConfiguration(get, set)
      },

      setAutoPostgain: (auto) => {
        set({
          autoPostgain: auto,
          ...(!auto && get().autoPostgain ? { postgainDb: 0 } : {}),
        })
        applyConfiguration(get, set)
      },

      setCurrentDevice: (name) => {
        if (!name || name === get().currentDevice) return
        const previous = get().currentDevice
        const outgoing = profileForDevice(get().deviceProfiles, previous)
        // An unsuccessful recall must not replace corrupt saved data with
        // settings inherited from the preceding output device.
        if (
          previous &&
          (!outgoing || validProfile(outgoing)) &&
          !clearedProfileNames(get().clearedDeviceProfiles).includes(previous)
        )
          get().saveProfileForDevice(previous)
        const profile = profileForDevice(get().deviceProfiles, name)
        set({ currentDevice: name })
        if (profile) {
          get().loadProfileForDevice(name)
        } else if (previous) {
          set({
            gains: [...FLAT] as EqGains,
            enabled: false,
            postgainDb: 0,
            autoPostgain: false,
          })
          applyConfiguration(get, set, true)
        } else {
          // First detection without a profile retains the global preference.
          applyConfiguration(get, set)
        }
      },

      saveProfileForDevice: (deviceName) => {
        if (!deviceName) return
        const { gains, enabled, postgainDb, autoPostgain, deviceProfiles } =
          get()
        set({
          clearedDeviceProfiles: clearedProfileNames(
            get().clearedDeviceProfiles
          ).filter((name) => name !== deviceName),
          deviceProfiles: {
            ...deviceProfiles,
            [deviceName]: {
              ...profileForDevice(deviceProfiles, deviceName),
              gains: [...gains] as EqGains,
              enabled,
              postgainDb,
              autoPostgain,
            },
          },
        })
      },

      deleteProfileForDevice: (deviceName) => {
        if (!deviceName) return
        const { deviceProfiles } = get()
        const next = { ...deviceProfiles }
        delete next[deviceName]
        set({
          deviceProfiles: next,
          clearedDeviceProfiles: [
            ...new Set([
              ...clearedProfileNames(get().clearedDeviceProfiles),
              deviceName,
            ]),
          ],
        })
      },

      loadProfileForDevice: (deviceName) => {
        const profile = profileForDevice(get().deviceProfiles, deviceName)
        if (!profile) return
        if (!validProfile(profile)) {
          ++configurationRevision
          set({
            applying: false,
            eqError: "The saved device equalizer profile is invalid.",
          })
          return
        }
        set({
          gains: clampGains(profile.gains),
          enabled: profile.enabled,
          // Automatic values are derived by the native filters, never recalled.
          postgainDb: profile.autoPostgain
            ? 0
            : Math.max(-24, Math.min(24, profile.postgainDb)),
          autoPostgain: profile.autoPostgain,
        })
        applyConfiguration(get, set, true)
      },
    }),
    {
      name: "plex-eq-v1",
      partialize: (state) => ({
        gains: state.gains,
        enabled: state.enabled,
        postgainDb: state.postgainDb,
        autoPostgain: state.autoPostgain,
        deviceProfiles: state.deviceProfiles,
        clearedDeviceProfiles: state.clearedDeviceProfiles,
        outputProfiles: state.outputProfiles,
        clearedOutputProfiles: state.clearedOutputProfiles,
        legacyOutputOwners: state.legacyOutputOwners,
        corrections: state.corrections,
      }),
    }
  )
)
