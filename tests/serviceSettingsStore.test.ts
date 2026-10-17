import { expect, test } from "bun:test"
import { createServiceSettingsStore } from "../src/stores/createServiceSettingsStore"
import { deferred } from "./helpers/radioAudioFakes"

test("service status loads coalesce and cannot overwrite an admitted configuration save", async () => {
  const read = deferred<{ revision: string }>()
  const write = deferred<{ revision: string }>()
  let reads = 0, writes = 0
  const store = createServiceSettingsStore("Fixture", {
    status: () => { reads++; return read.promise },
    configure: () => { writes++; return write.promise },
  }, () => true)
  const first = store.getState().load()
  const shared = store.getState().load()
  expect(reads).toBe(1)
  read.resolve({ revision: "original" })
  await Promise.all([first, shared])
  const saved = store.getState().configure({ baseUrl: "https://fixture.test", enabled: true })
  expect(store.getState().status).toBeNull()
  await store.getState().load()
  expect(reads).toBe(1)
  expect(await store.getState().configure({ baseUrl: "https://fixture.test", enabled: false })).toBe(false)
  expect(writes).toBe(1)
  write.resolve({ revision: "saved" })
  expect(await saved).toBe(true)
  expect(store.getState().status?.revision).toBe("saved")
})
