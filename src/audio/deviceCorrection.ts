/** Parametric device correction, independent of the ten-band tone equalizer. */
export interface CorrectionFilter {
  kind: "PK" | "LSC" | "HSC"
  frequency: number
  gainDb: number
  q: number
  enabled: boolean
}
export interface CorrectionProfile { preampDb: number; filters: CorrectionFilter[] }
export interface CorrectionSource {
  kind: "autoeq" | "custom"
  url: string | null
  revision: string | null
  measurement: string | null
  rig: string | null
  target: string | null
  license: string | null
}
export interface SavedCorrection {
  id: string
  label: string
  originalText: string
  editedText?: string
  source: CorrectionSource
  createdAt: number
}
const finite = (value: unknown, low: number, high: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high
export function validateCorrection(profile: CorrectionProfile) {
  if (!profile || !finite(profile.preampDb, -60, 12)) throw Error("Preamp must be between −60 and +12 dB.")
  if (!Array.isArray(profile.filters) || !profile.filters.length || profile.filters.length > 20) throw Error("Choose between 1 and 20 parametric filters.")
  for (const filter of profile.filters) {
    if (!filter || !["PK", "LSC", "HSC"].includes(filter.kind) || typeof filter.enabled !== "boolean") throw Error("Use peak (PK), low shelf (LSC) or high shelf (HSC) filters.")
    if (!finite(filter.frequency, 10, 24000)) throw Error("Filter frequency must be between 10 and 24,000 Hz.")
    if (!finite(filter.gainDb, -30, 30)) throw Error("Filter gain must be between −30 and +30 dB.")
    if (!finite(filter.q, 0.1, 30)) throw Error("Filter Q must be between 0.1 and 30.")
  }
  return profile
}
const number = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)"
const preampLine = new RegExp(`^Preamp:\\s*${number}\\s+dB$`, "i")
const filterLine = new RegExp(`^Filter\\s+([1-9]\\d{0,2}):\\s*(ON|OFF)\\s+(PK|LSC|HSC)\\s+Fc\\s+${number}\\s+Hz\\s+Gain\\s+${number}\\s+dB\\s+Q\\s+${number}$`, "i")
/** Unsupported APO directives are errors, never silently approximated or run. */
export function parseCorrection(text: string): CorrectionProfile {
  if (typeof text !== "string" || text.length > 65536 || new TextEncoder().encode(text).byteLength > 65536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw Error("Choose a parametric EQ text file up to 64 KB.")
  const filters: CorrectionFilter[] = [], ordinals = new Set<number>()
  let preampDb: number | undefined
  for (const [index, raw] of text.replace(/^\ufeff/, "").split(/\r?\n/).entries()) {
    const line = raw.split("#", 1)[0].trim()
    if (!line || line.startsWith(";")) continue
    const preamp = preampLine.exec(line)
    if (preamp) {
      if (preampDb !== undefined) throw Error(`Line ${index + 1}: preamp is specified more than once.`)
      preampDb = Number(preamp[1]); continue
    }
    const filter = filterLine.exec(line)
    if (!filter) throw Error(`Line ${index + 1}: use Preamp or an ON/OFF PK, LSC or HSC filter with Fc, Gain and Q.`)
    const ordinal = Number(filter[1])
    if (ordinals.has(ordinal)) throw Error(`Line ${index + 1}: filter number is repeated.`)
    ordinals.add(ordinal)
    filters.push({ kind: filter[3].toUpperCase() as CorrectionFilter["kind"], enabled: filter[2].toUpperCase() === "ON",
      frequency: Number(filter[4]), gainDb: Number(filter[5]), q: Number(filter[6]) })
    if (filters.length > 20) throw Error("Choose between 1 and 20 parametric filters.")
  }
  if (preampDb === undefined) throw Error("Include a Preamp value in dB.")
  return validateCorrection({ preampDb, filters })
}
export const correctionProfile = (saved: SavedCorrection) => parseCorrection(saved.editedText ?? saved.originalText)
export function editCorrection(saved: SavedCorrection, text: string): SavedCorrection {
  parseCorrection(text)
  return { ...saved, editedText: text === saved.originalText ? undefined : text }
}
