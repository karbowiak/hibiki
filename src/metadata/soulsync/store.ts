import { isTauri } from "@tauri-apps/api/core"
import { createServiceSettingsStore } from "../../stores/createServiceSettingsStore"
import { soulSyncConfigure, soulSyncStatus } from "./api"

export function createSoulSyncStore(
  api = { status: soulSyncStatus, configure: soulSyncConfigure },
  desktop = isTauri
) {
  return createServiceSettingsStore("SoulSync", api, desktop)
}
export const useSoulSyncStore = createSoulSyncStore()
