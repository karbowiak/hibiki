import { isTauri } from "@tauri-apps/api/core"
import { createServiceSettingsStore } from "../../stores/createServiceSettingsStore"
import {
  metadataServiceConfigure,
  metadataServiceStatus,
  type ConfiguredMetadataService,
} from "./api"

export function createConfiguredMetadataServiceStore(
  service: ConfiguredMetadataService,
  api = {
    status: () => metadataServiceStatus(service),
    configure: (args: Parameters<typeof metadataServiceConfigure>[1]) =>
      metadataServiceConfigure(service, args),
  },
  desktop = isTauri
) {
  return createServiceSettingsStore("Metadata service", api, desktop)
}
export const useFanartServiceStore =
  createConfiguredMetadataServiceStore("fanart")
export const useHeyaServiceStore = createConfiguredMetadataServiceStore("heya")
