// Singleton module for loading and managing all 555 Milkdrop presets.
// Not React, not Zustand — plain module state.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PresetData = any

let allNames: string[] = []
const allPresets: Record<string, PresetData> = {}
let packsLoaded = 0
const TOTAL_PACKS = 6

/** Import the meta pack (~30KB) to extract all 555 preset names without loading full data. */
export async function initPresetMeta(): Promise<string[]> {
  if (allNames.length > 0) return allNames

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = ((await import("butterchurn-presets/lib/butterchurnPresetPackMeta.min")) as any).default

  const nameSet = new Set<string>()
  const methods = [
    "getMainPresetMeta",
    "getExtraPresetKeys",
    "getExtra2PresetKeys",
    "getMinimalPresetKeys",
    "getNonMinimalPresetKeys",
    "getMD1PresetKeys",
  ] as const

  for (const method of methods) {
    const { presets } = meta[method]()
    for (const name of presets) nameSet.add(name)
  }

  allNames = [...nameSet].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  return allNames
}

/** Load all 6 preset packs in parallel. Calls onProgress(loaded, total) as each resolves. */
export async function loadAllPacks(onProgress?: (loaded: number, total: number) => void): Promise<void> {
  if (packsLoaded >= TOTAL_PACKS) return

  // Each import MUST be a string literal for Vite's static analysis
  const packImports = [
    import("butterchurn-presets"),
    import("butterchurn-presets/lib/butterchurnPresetsExtra.min"),
    import("butterchurn-presets/lib/butterchurnPresetsExtra2.min"),
    import("butterchurn-presets/lib/butterchurnPresetsMD1.min"),
    import("butterchurn-presets/lib/butterchurnPresetsMinimal.min"),
    import("butterchurn-presets/lib/butterchurnPresetsNonMinimal.min"),
  ]

  let loaded = 0
  await Promise.all(
    packImports.map(async (p) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await p) as any
      // Each pack exports a class with a static .getPresets() method
      const pack = mod.default ?? mod
      const presets: Record<string, PresetData> = typeof pack.getPresets === "function" ? pack.getPresets() : pack
      Object.assign(allPresets, presets)
      loaded++
      packsLoaded = loaded
      onProgress?.(loaded, TOTAL_PACKS)
    }),
  )
}

/** Get preset data by name, or null if not yet loaded. */
export function getPreset(name: string): PresetData | null {
  return allPresets[name] ?? null
}

/** Get the sorted list of all preset names (available after initPresetMeta). */
export function getAllNames(): string[] {
  return allNames
}

/** True when all 6 packs have been imported. */
export function isFullyLoaded(): boolean {
  return packsLoaded >= TOTAL_PACKS
}
