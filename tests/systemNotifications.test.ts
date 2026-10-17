import { expect, test } from "bun:test"
import { createNotificationCenterStore } from "../src/stores/notificationCenterStore"
import { connectSystemNotifications } from "../src/lib/systemNotifications"
import { deferred } from "./helpers/radioAudioFakes"

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
const issue = {
  id: "scrobbling",
  title: "Scrobbling delayed",
  message: "History is saved locally.",
  severity: "warning" as const,
  persistent: true,
}

test("system alerts require opt-in, background focus and an actual warning", async () => {
  const store = createNotificationCenterStore()
  let enabled = false,
    background = true,
    checked = 0
  const sent: string[] = []
  const stop = connectSystemNotifications({
    store,
    enabled: () => enabled,
    background: () => background,
    permission: async () => {
      checked++
      return true
    },
    send: (n) => {
      sent.push(n.id)
    },
  })
  store.getState().notify(issue)
  await tick()
  expect(checked).toBe(0)
  enabled = true
  store.getState().notify({ ...issue, id: "information", severity: "info" })
  background = false
  store.getState().notify({ ...issue, id: "foreground" })
  await tick()
  expect(checked).toBe(0)
  background = true
  store.getState().notify({ ...issue, id: "background" })
  await tick()
  expect(sent).toEqual(["background"])
  stop()
})

test("status polls and notification actions cannot repeatedly send the same system alert", async () => {
  const store = createNotificationCenterStore()
  const sent: string[] = []
  const stop = connectSystemNotifications({
    store,
    enabled: () => true,
    background: () => true,
    permission: async () => true,
    send: (n) => {
      sent.push(n.id)
    },
  })
  store.getState().notify(issue)
  await tick()
  store
    .getState()
    .notify({
      ...issue,
      message: "Still waiting for a retry.",
      action: { label: "Retry", run: () => {} },
    })
  store.getState().markAllRead()
  await store.getState().runAction(issue.id)
  await tick()
  expect(sent).toEqual([issue.id])
  store.getState().resolve(issue.id)
  store.getState().notify(issue)
  await tick()
  expect(sent).toEqual([issue.id])
  store.getState().resolve(issue.id)
  store.getState().notify({...issue,eventKey:"new-failure"})
  await tick()
  expect(sent).toEqual([issue.id, issue.id])
  stop()
})

for (const change of [
  "unmount",
  "disable",
  "foreground",
  "resolve",
  "dismiss",
  "replace",
] as const) {
  test(`a pending system permission check cannot deliver after ${change}`, async () => {
    const store = createNotificationCenterStore()
    const gate = deferred<boolean>()
    let enabled = true,
      background = true
    const sent: string[] = []
    const stop = connectSystemNotifications({
      store,
      enabled: () => enabled,
      background: () => background,
      permission: () => gate.promise,
      send: (n) => {
        sent.push(n.id)
      },
    })
    store.getState().notify(issue)
    if (change === "unmount") stop()
    if (change === "disable") enabled = false
    if (change === "foreground") background = false
    if (change === "resolve") store.getState().resolve(issue.id)
    if (change === "dismiss") store.getState().dismissToast(issue.id)
    if (change === "replace") {
      store.getState().resolve(issue.id)
      store.getState().notify({ ...issue, severity: "info" })
    }
    gate.resolve(true)
    await tick()
    expect(sent).toEqual([])
    stop()
  })
}

test("failed or denied system delivery preserves the notification in Hibiki", async () => {
  for (const permission of [
    async () => false,
    async () => {
      throw Error("unavailable")
    },
    async () => true,
  ]) {
    const store = createNotificationCenterStore()
    const stop = connectSystemNotifications({
      store,
      enabled: () => true,
      background: () => true,
      permission,
      send: () => {
        throw Error("delivery failed")
      },
    })
    store.getState().notify(issue)
    await tick()
    expect(store.getState().notifications[0].active).toBe(true)
    expect(store.getState().notifications[0].message).toBe(issue.message)
    stop()
  }
})
