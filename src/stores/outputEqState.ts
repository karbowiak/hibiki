import {
  correctionProfile,
  type SavedCorrection,
} from "../audio/deviceCorrection"
import type { AppliedEq } from "../audio/RustAudioEngine"
import type { OutputIdentity } from "../audio/outputIdentity"
import type { EqState, EqProfile } from "./eqStore"

export interface OutputProfile extends EqProfile {
  name: string
  correctionId: string | null
  correctionEnabled: boolean
  automatic: boolean
  legacyName?: string
}
export interface OutputEqState {
  outputIdentityKnown: boolean
  currentOutput: OutputIdentity | null
  outputProfiles: Record<string, OutputProfile>
  clearedOutputProfiles: string[]
  legacyOutputOwners: Record<string, string>
  corrections: Record<string, SavedCorrection>
  selectedCorrectionId: string | null
  correctionEnabled: boolean
  correctionPreview: SavedCorrection | null
  appliedEq: AppliedEq | null
  appliedOutputKey: string | null
  setCurrentOutput: (
    output: OutputIdentity | null,
    uniqueName?: boolean
  ) => void
  saveOutputProfile: () => void
  removeOutputProfile: (id: string) => void
  recallOutputProfile: () => void
  setAutomaticRecall: (enabled: boolean) => void
  chooseCorrection: (id: string | null) => void
  setCorrectionEnabled: (enabled: boolean) => void
  saveCorrection: (profile: SavedCorrection) => void
  removeCorrection: (id: string) => void
  previewCorrection: (profile: SavedCorrection, outputKey: string) => void
  cancelCorrectionPreview: (outputKey: string) => void
}
type Set = (patch: Partial<EqState>) => void
const flat = () => ({
  gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as EqProfile["gains"],
  enabled: false,
  postgainDb: 0,
  autoPostgain: false,
})
function valid(profile: EqProfile) {
  return (
    profile &&
    Array.isArray(profile.gains) &&
    profile.gains.length === 10 &&
    profile.gains.every(Number.isFinite) &&
    typeof profile.enabled === "boolean" &&
    typeof profile.autoPostgain === "boolean" &&
    (profile.autoPostgain || Number.isFinite(profile.postgainDb))
  )
}
const own = <T>(items: Record<string, T>, id: string): T | undefined =>
  Object.hasOwn(items, id) ? items[id] : undefined

/** Automatic postgain is derived by native DSP, so it is not a user edit. */
export function outputEqMatches(state: EqProfile & Pick<OutputEqState, "selectedCorrectionId" | "correctionEnabled">, profile: OutputProfile | null | undefined): boolean {
  return !!profile && valid(profile) && profile.enabled === state.enabled && profile.autoPostgain === state.autoPostgain &&
    (state.autoPostgain || profile.postgainDb === state.postgainDb) &&
    profile.correctionId === state.selectedCorrectionId && profile.correctionEnabled === state.correctionEnabled &&
    profile.gains.length === state.gains.length && profile.gains.every((gain, index) => gain === state.gains[index])
}

export function createOutputEqState(
  set: Set,
  get: () => EqState,
  apply: () => void,
  invalidate: () => void
): OutputEqState {
  const recall = (profile: OutputProfile) => {
    if (!valid(profile)) {
      set({
        ...flat(),
        selectedCorrectionId: null,
        correctionEnabled: false,
        correctionPreview: null,
        eqError: "The saved output settings are invalid.",
      })
      return
    }
    set({
      gains: profile.gains.map((value) =>
        Math.max(-12, Math.min(12, value))
      ) as EqProfile["gains"],
      enabled: profile.enabled,
      postgainDb: profile.autoPostgain
        ? 0
        : Math.max(-24, Math.min(24, profile.postgainDb)),
      autoPostgain: profile.autoPostgain,
      selectedCorrectionId: profile.correctionId,
      correctionEnabled: profile.correctionEnabled,
      correctionPreview: null,
    })
    apply()
  }
  return {
    outputIdentityKnown: false,
    currentOutput: null,
    outputProfiles: {},
    clearedOutputProfiles: [],
    legacyOutputOwners: {},
    corrections: {},
    selectedCorrectionId: null,
    correctionEnabled: false,
    correctionPreview: null,
    appliedEq: null,
    appliedOutputKey: null,
    setCurrentOutput: (output, uniqueName = false) => {
      const previous = get().currentOutput
      set({ outputIdentityKnown: true })
      if (!previous && !output) {
        invalidate()
        set({
          applying: false,
          appliedEq: null,
          appliedOutputKey: null,
          selectedCorrectionId: null,
          correctionEnabled: false,
        })
        return
      }
      if (
        previous?.key === output?.key &&
        previous?.id === output?.id &&
        previous?.available === output?.available
      ) {
        if (output && output.name !== previous?.name)
          set({ currentOutput: output, currentDevice: output.name })
        return
      }
      invalidate()
      // The outgoing binding owns its edits; never save a temporary preview.
      const outgoing = previous && own(get().outputProfiles, previous.id)
      if (
        previous?.available &&
        (output?.id !== previous.id || !output.available) &&
        outgoing &&
        valid(outgoing) &&
        !get().clearedOutputProfiles.includes(previous.id)
      )
        get().saveOutputProfile()
      set({
        currentOutput: output,
        currentDevice: output?.name ?? previous?.name ?? "",
        correctionPreview: null,
        applying: false,
        appliedEq: null,
        appliedOutputKey: null,
        ...(!output
          ? { selectedCorrectionId: null, correctionEnabled: false }
          : {}),
      })
      if (!output?.available) return
      let profile = own(get().outputProfiles, output.id)
      const legacy = own(get().deviceProfiles, output.name)
      // Once a name was ambiguous, a later disconnect cannot make its historical
      // owner provable. Retain the old preset for explicit manual loading.
      if (
        legacy &&
        !uniqueName &&
        own(get().legacyOutputOwners, output.name) === undefined
      ) {
        set({
          legacyOutputOwners: {
            ...get().legacyOutputOwners,
            [output.name]: "",
          },
        })
      }
      if (
        !profile &&
        output.stable &&
        uniqueName &&
        legacy &&
        valid(legacy) &&
        (own(get().legacyOutputOwners, output.name) === undefined ||
          own(get().legacyOutputOwners, output.name) === output.id) &&
        !get().clearedOutputProfiles.includes(output.id) &&
        !get().clearedDeviceProfiles.includes(output.name)
      ) {
        profile = {
          ...legacy,
          gains: [...legacy.gains],
          name: output.name,
          automatic: true,
          correctionId: null,
          correctionEnabled: false,
          legacyName: output.name,
        }
        set({
          outputProfiles: { ...get().outputProfiles, [output.id]: profile },
          legacyOutputOwners: {
            ...get().legacyOutputOwners,
            [output.name]: output.id,
          },
        })
      }
      if (profile?.automatic && output.stable) recall(profile)
      else {
        // Global tone preferences survive first detection; correction never does.
        set({
          ...(previous ? flat() : {}),
          selectedCorrectionId: null,
          correctionEnabled: false,
        })
        apply()
      }
    },
    saveOutputProfile: () => {
      const state = get(),
        output = state.currentOutput
      if (!output?.available || !valid(state)) return
      const previous = own(state.outputProfiles, output.id)
      set({
        outputProfiles: {
          ...state.outputProfiles,
          [output.id]: {
            ...previous,
            name: output.name,
            gains: [...state.gains],
            enabled: state.enabled,
            postgainDb: state.postgainDb,
            autoPostgain: state.autoPostgain,
            correctionId: state.selectedCorrectionId,
            correctionEnabled: state.correctionEnabled,
            automatic: previous?.automatic ?? output.stable,
          },
        },
        clearedOutputProfiles: state.clearedOutputProfiles.filter(
          (id) => id !== output.id
        ),
      })
    },
    removeOutputProfile: (id) => {
      const profiles = { ...get().outputProfiles }
      delete profiles[id]
      set({
        outputProfiles: profiles,
        clearedOutputProfiles: [
          ...new Set([...get().clearedOutputProfiles, id]),
        ],
      })
      if (get().currentOutput?.id === id) {
        set({
          selectedCorrectionId: null,
          correctionEnabled: false,
          correctionPreview: null,
        })
        apply()
      }
    },
    recallOutputProfile: () => {
      const output = get().currentOutput
      const profile = output && own(get().outputProfiles, output.id)
      if (output?.available && profile) recall(profile)
    },
    setAutomaticRecall: (automatic) => {
      const output = get().currentOutput
      if (!output?.available || (automatic && !output.stable)) return
      get().saveOutputProfile()
      const profile = get().outputProfiles[output.id]
      if (profile)
        set({
          outputProfiles: {
            ...get().outputProfiles,
            [output.id]: { ...profile, automatic },
          },
        })
    },
    chooseCorrection: (id) => {
      if (id) {
        const profile = own(get().corrections, id)
        if (!profile) return
        correctionProfile(profile)
      }
      set({
        selectedCorrectionId: id,
        correctionEnabled: !!id,
        correctionPreview: null,
      })
      apply()
    },
    setCorrectionEnabled: (correctionEnabled) => {
      set({ correctionEnabled, correctionPreview: null })
      apply()
    },
    saveCorrection: (profile) => {
      correctionProfile(profile)
      const original = own(get().corrections, profile.id)
      // Source data is immutable; subsequent editing only replaces the edit text.
      const saved = original
        ? { ...original, label: profile.label, editedText: profile.editedText }
        : profile
      correctionProfile(saved)
      set({ corrections: { ...get().corrections, [profile.id]: saved } })
      get().chooseCorrection(profile.id)
    },
    removeCorrection: (id) => {
      const corrections = { ...get().corrections }
      delete corrections[id]
      const outputProfiles = Object.fromEntries(
        Object.entries(get().outputProfiles).map(([key, profile]) => [
          key,
          profile.correctionId === id
            ? { ...profile, correctionId: null, correctionEnabled: false }
            : profile,
        ])
      )
      set({ corrections, outputProfiles })
      if (get().selectedCorrectionId === id) get().chooseCorrection(null)
    },
    previewCorrection: (profile, outputKey) => {
      if (
        get().currentOutput?.key !== outputKey ||
        !get().currentOutput?.available
      )
        return
      correctionProfile(profile)
      set({ correctionPreview: profile })
      apply()
    },
    cancelCorrectionPreview: (outputKey) => {
      if (get().currentOutput?.key !== outputKey || !get().correctionPreview)
        return
      set({ correctionPreview: null })
      apply()
    },
  }
}
