import { invoke } from "@tauri-apps/api/core"
import type { PlexRequestContext, PlexTransport } from "../scopedApi"
export interface LibraryServer {
  id: string
  name: string
  current: boolean
}
export interface MusicLibrary {
  key: number
  uuid: string | null
  title: string
}
export interface LibraryConnection {
  baseUrl: string
  token: string
  allUrls: string[]
  machineIdentifier: string
  sectionId: number
  sectionUuid: string | null
}
export function createLibraryPickerApi(
  context: PlexRequestContext,
  current: () => boolean,
  transport: PlexTransport = invoke
) {
  const captured = Object.freeze({ ...context })
  const call = async <T>(
    command: string,
    args: Record<string, unknown> = {}
  ): Promise<T> => {
    if (!current()) throw Error("Library selection was superseded")
    const result = await transport<T>(command, { ...args, context: captured })
    if (!current()) throw Error("Library selection was superseded")
    return result
  }
  return {
    servers: () =>
      call<{ servers: LibraryServer[]; notice: string | null }>(
        "library_picker_servers"
      ),
    sections: (serverId: string) =>
      call<MusicLibrary[]>("library_picker_sections", { serverId }),
    resolve: (serverId: string, section: MusicLibrary) =>
      call<LibraryConnection>("library_picker_resolve", {
        serverId,
        sectionId: section.key,
        sectionUuid: section.uuid,
      }),
  }
}
