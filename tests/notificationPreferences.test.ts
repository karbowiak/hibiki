import { expect, test } from "bun:test"
import { createNotificationPreferenceStore } from "../src/stores/notificationStore"
import type { ScalarPreference } from "../src/stores/scalarPreference"
import { deferred } from "./helpers/radioAudioFakes"

function preference(initial: boolean) {
  let value = initial
  const listeners = new Set<() => void>(),
    writes: boolean[] = []
  const backend: ScalarPreference<boolean> = {
    snapshot: () => value,
    set: (next) => {
      value = next
      writes.push(next)
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    backend,
    writes,
    hydrate(next: boolean) {
      value = next
      listeners.forEach((listener) => listener())
    },
  }
}

test("restoring optional warning notifications never checks or prompts for system permission", () => {
  const track = preference(false),
    warnings = preference(true)
  let permissionCalls = 0
  const store = createNotificationPreferenceStore({
    trackPreference: track.backend,
    warningPreference: warnings.backend,
    permissions: {
      isPermissionGranted: async () => {
        ++permissionCalls
        return false
      },
      requestPermission: async () => {
        ++permissionCalls
        return "granted"
      },
    },
  })
  expect(store.getState()).toMatchObject({
    notificationsEnabled: false,
    warningNotificationsEnabled: true,
  })
  warnings.hydrate(false)
  warnings.hydrate(true)
  expect(permissionCalls).toBe(0)
  expect(warnings.writes).toEqual([])
  store.getState().setNotificationsEnabled(true)
  expect(track.writes).toEqual([true])
  expect(warnings.writes).toEqual([])
})

test("only explicit opt-in requests permission; denial cannot claim the option is enabled", async () => {
  const track = preference(true),
    warnings = preference(false)
  let prompts = 0
  const store = createNotificationPreferenceStore({
    trackPreference: track.backend,
    warningPreference: warnings.backend,
    permissions: {
      isPermissionGranted: async () => false,
      requestPermission: async () => {
        ++prompts
        return "denied"
      },
    },
  })
  expect(prompts).toBe(0)
  expect(await store.getState().setWarningNotificationsEnabled(true)).toBe(
    false
  )
  expect(prompts).toBe(1)
  expect(warnings.writes).toEqual([])
  expect(store.getState().warningNotificationsEnabled).toBe(false)
  expect(await store.getState().setWarningNotificationsEnabled(false)).toBe(
    true
  )
  expect(prompts).toBe(1)
})

test("granted permission enables only warning notifications and never opens an unnecessary prompt", async () => {
  const track = preference(false),
    warnings = preference(false)
  const store = createNotificationPreferenceStore({
    trackPreference: track.backend,
    warningPreference: warnings.backend,
    permissions: {
      isPermissionGranted: async () => true,
      requestPermission: async () => {
        throw Error("unexpected prompt")
      },
    },
  })
  expect(await store.getState().setWarningNotificationsEnabled(true)).toBe(true)
  expect(warnings.writes).toEqual([true])
  expect(store.getState().notificationsEnabled).toBe(false)
  expect(track.writes).toEqual([])
})

test("a delayed opt-in cannot re-enable warnings after an explicit disable", async () => {
  const track = preference(true),
    warnings = preference(false),
    permission = deferred<string>()
  const store = createNotificationPreferenceStore({
    trackPreference: track.backend,
    warningPreference: warnings.backend,
    permissions: {
      isPermissionGranted: async () => false,
      requestPermission: () => permission.promise,
    },
  })
  const old = store.getState().setWarningNotificationsEnabled(true)
  await Promise.resolve()
  await store.getState().setWarningNotificationsEnabled(false)
  permission.resolve("granted")
  expect(await old).toBe(false)
  expect(warnings.writes).toEqual([false])
  expect(store.getState().warningNotificationsEnabled).toBe(false)
})

test("simultaneous settings enables share one prompt and permission errors remain retryable", async () => {
  const track = preference(true),
    warnings = preference(false),
    permission = deferred<string>()
  let prompts = 0
  const store = createNotificationPreferenceStore({
    trackPreference: track.backend,
    warningPreference: warnings.backend,
    permissions: {
      isPermissionGranted: async () => false,
      requestPermission: () => {
        ++prompts
        return permission.promise
      },
    },
  })
  const first = store.getState().setWarningNotificationsEnabled(true),
    latest = store.getState().setWarningNotificationsEnabled(true)
  await Promise.resolve()
  expect(prompts).toBe(1)
  permission.reject(Error("synthetic permission failure"))
  expect(await first).toBe(false)
  expect(await latest).toBe(false)
  expect(warnings.writes).toEqual([])
  store.getState().setNotificationsEnabled(false)
  expect(track.writes).toEqual([false])
})
