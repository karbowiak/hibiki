import { expect, test } from "bun:test"
import { createLibraryPickerApi } from "../src/backends/plex/libraryPicker/api"
import { deferred } from "./helpers/radioAudioFakes"
test("library picker captures account context and rejects retired discovery or credential resolution", async () => {
  const context = { connectionRevision: 7, cacheScope: "owned-library" },
    calls: any[] = []
  let current = true
  const pending = deferred<any>()
  const api = createLibraryPickerApi(
    context,
    () => current,
    async (command, args) => {
      calls.push({ command, args })
      return pending.promise
    }
  )
  const result = api.resolve("opaque-server", {
    key: 5,
    uuid: "library-uuid",
    title: "Music",
  })
  context.connectionRevision = 8
  expect(calls[0]).toEqual({
    command: "library_picker_resolve",
    args: {
      context: { connectionRevision: 7, cacheScope: "owned-library" },
      serverId: "opaque-server",
      sectionId: 5,
      sectionUuid: "library-uuid",
    },
  })
  current = false
  pending.resolve({ token: "fixture-per-resource-token" })
  await expect(result).rejects.toThrow("superseded")
  await expect(api.servers()).rejects.toThrow("superseded")
  expect(calls).toHaveLength(1)
})
