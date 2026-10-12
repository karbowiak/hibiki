import { expect, test } from "bun:test"
import { createConfiguredMetadataServiceStore } from "../src/metadata/services/store"
import { deferred } from "./helpers/radioAudioFakes"
test("native service configuration retires cached ownership even after unknown save failure, without exposing keys", async () => {
  const pending = deferred<any>()
  let reads = 0,
    argumentsSent: any
  const status = {
    revision: "A",
    baseUrl: "https://synthetic.test",
    configured: true,
    hasApiKey: true,
    enabled: true,
  }
  const store = createConfiguredMetadataServiceStore(
    "heya",
    {
      status: async () => {
        reads++
        return status
      },
      configure: (args) => {
        argumentsSent = args
        return pending.promise
      },
    },
    () => true
  )
  await store.getState().load()
  const save = store
    .getState()
    .configure({
      baseUrl: status.baseUrl,
      apiKey: "fictional-native-only-key",
      enabled: true,
    })
  expect(store.getState().status).toBeNull()
  await store.getState().load()
  expect(reads).toBe(1)
  expect(argumentsSent.apiKey).toBe("fictional-native-only-key")
  expect(JSON.stringify(store.getState())).not.toContain(
    "fictional-native-only-key"
  )
  pending.reject(new Error("fictional-native-only-key private raw exception"))
  expect(await save).toBe(false)
  expect(store.getState().status).toBeNull()
  expect(store.getState().error).not.toContain("fictional-native-only-key")
  await store.getState().load()
  expect(store.getState().status?.revision).toBe("A")
})
