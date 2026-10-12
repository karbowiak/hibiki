import { expect, test } from "bun:test"
import {
  createNotificationCenterStore,
  type NotificationInput,
} from "../src/stores/notificationCenterStore"
import { deferred } from "./helpers/radioAudioFakes"

const notice = (
  changes: Partial<NotificationInput> = {}
): NotificationInput => ({
  id: "listening-sync",
  title: "Listening sync",
  message: "Queued for retry",
  severity: "warning",
  persistent: true,
  ...changes,
})
const fixture = () => {
  let timestamp = 100
  const store = createNotificationCenterStore({ now: () => ++timestamp })
  return {
    store,
    state: () => store.getState(),
    entry: () => store.getState().notifications[0],
  }
}

test("status polling updates message and action without repeating dismissed or read notifications", () => {
  const h = fixture(),
    oldAction = () => {},
    latestAction = () => {}
  h.state().notify(notice({ action: { label: "Retry", run: oldAction } }))
  const first = h.entry()
  h.state().dismissToast(first.id)
  h.state().markAllRead()
  h.state().notify(
    notice({
      message: "A second listen is queued",
      action: { label: "Retry now", run: latestAction },
    })
  )
  expect(h.state().notifications).toHaveLength(1)
  expect(h.entry()).toMatchObject({
    message: "A second listen is queued",
    toastVisible: false,
    unread: false,
    occurrences: 1,
    toastRevision: 1,
    createdAt: first.createdAt,
  })
  expect(h.entry().updatedAt).toBeGreaterThan(first.updatedAt)
  expect(h.entry().action?.run).toBe(latestAction)
})

test("severity escalation makes an ongoing issue visible again; lower severity stays quiet", () => {
  const h = fixture()
  h.state().notify(notice())
  h.state().dismissToast("listening-sync")
  h.state().markAllRead()
  h.state().notify(notice({ severity: "error" }))
  expect(h.entry()).toMatchObject({
    unread: true,
    toastVisible: true,
    occurrences: 1,
    toastRevision: 2,
  })
  h.state().dismissToast("listening-sync")
  h.state().markAllRead()
  h.state().notify(notice({ severity: "info" }))
  expect(h.entry()).toMatchObject({
    unread: false,
    toastVisible: false,
    toastRevision: 2,
  })
})

test("resolution preserves history, removes stale retries, and recurrence starts a new toast", () => {
  const h = fixture()
  h.state().notify(notice({ action: { label: "Retry", run: () => {} } }))
  const original = h.entry()
  h.state().resolve(original.id)
  expect(h.entry()).toMatchObject({
    active: false,
    toastVisible: false,
    actionPending: false,
  })
  expect(h.entry().action).toBeUndefined()
  h.state().markAllRead()
  h.state().notify(notice())
  expect(h.entry()).toMatchObject({
    active: true,
    unread: true,
    toastVisible: true,
    occurrences: 2,
    toastRevision: 2,
    createdAt: original.createdAt,
  })
  h.state().dismissToast(original.id, original.toastRevision)
  expect(h.entry().toastVisible).toBe(true)
  h.state().dismissToast(original.id, 2)
  expect(h.entry().toastVisible).toBe(false)
})

test("transient events repeat while dismissal preserves their unread history", () => {
  const h = fixture()
  h.state().notify(notice({ persistent: false, severity: "success" }))
  h.state().dismissToast("listening-sync")
  expect(h.entry()).toMatchObject({
    active: false,
    unread: true,
    toastVisible: false,
  })
  h.state().notify(notice({ persistent: false, message: "Completed again" }))
  expect(h.entry()).toMatchObject({
    occurrences: 2,
    toastRevision: 2,
    unread: true,
    toastVisible: true,
  })
})

test("history pruning retains unresolved issues and the newest inactive events", () => {
  const store = createNotificationCenterStore({ historyLimit: 3 })
  const s = () => store.getState()
  s().notify(notice({ id: "active" }))
  for (const id of ["old", "middle", "new"])
    s().notify(notice({ id, persistent: false }))
  expect(s().notifications.map((entry) => entry.id)).toEqual([
    "new",
    "middle",
    "active",
  ])
  s().clearHistory()
  expect(s().notifications.map((entry) => entry.id)).toEqual(["active"])
  for (const id of ["second", "third", "fourth"]) s().notify(notice({ id }))
  expect(s().notifications).toHaveLength(4)
  s().notify(notice({ id: "inactive", persistent: false }))
  expect(s().notifications).toHaveLength(4)
  expect(s().notifications.every((entry) => entry.active)).toBe(true)
  s().resolve("active")
  s().clearHistory()
  expect(s().notifications.map((entry) => entry.id)).toEqual([
    "fourth",
    "third",
    "second",
  ])
})

test("panel and toast retries share one pending action and failures remain retryable", async () => {
  const h = fixture(),
    request = deferred<void>()
  let calls = 0
  h.state().notify(
    notice({
      action: {
        label: "Retry",
        run: () => {
          ++calls
          return request.promise
        },
      },
    })
  )
  const first = h.state().runAction("listening-sync"),
    second = h.state().runAction("listening-sync")
  expect(second).toBe(first)
  await Promise.resolve()
  expect(calls).toBe(1)
  expect(h.entry().actionPending).toBe(true)
  request.reject(new Error("synthetic failure"))
  await expect(first).rejects.toThrow("synthetic failure")
  expect(h.entry().actionPending).toBe(false)
  let retries = 0
  h.state().notify(
    notice({
      action: {
        label: "Retry",
        run: () => {
          ++retries
        },
      },
    })
  )
  await h.state().runAction("listening-sync")
  expect(retries).toBe(1)
})

test("an old retry finishing cannot clear a newer recurrence's pending action", async () => {
  const h = fixture(),
    old = deferred<void>(),
    current = deferred<void>()
  h.state().notify(notice({ action: { label: "Old", run: () => old.promise } }))
  const prior = h.state().runAction("listening-sync")
  h.state().resolve("listening-sync")
  h.state().notify(
    notice({ action: { label: "New", run: () => current.promise } })
  )
  const next = h.state().runAction("listening-sync")
  old.resolve()
  await prior
  expect(h.entry().actionPending).toBe(true)
  current.resolve()
  await next
  expect(h.entry().actionPending).toBe(false)
})

test("a toast timer from cleared history cannot hide a later event reusing the same ID", () => {
  const h = fixture()
  h.state().notify(notice({ persistent: false }))
  const oldRevision = h.entry().toastRevision
  h.state().clearHistory()
  h.state().notify(notice({ persistent: false }))
  h.state().dismissToast("listening-sync", oldRevision)
  expect(h.entry().toastVisible).toBe(true)
  expect(h.entry().toastRevision).toBeGreaterThan(oldRevision)
})

test("polling replaces retry callbacks without allowing a second simultaneous retry", async () => {
  const h = fixture(),
    old = deferred<void>()
  let latestCalls = 0
  h.state().notify(
    notice({ action: { label: "Retry", run: () => old.promise } })
  )
  const pending = h.state().runAction("listening-sync")
  h.state().notify(
    notice({
      action: {
        label: "Retry",
        run: () => {
          ++latestCalls
        },
      },
    })
  )
  expect(h.state().runAction("listening-sync")).toBe(pending)
  expect(h.entry().actionPending).toBe(true)
  old.resolve()
  await pending
  expect(latestCalls).toBe(0)
  await h.state().runAction("listening-sync")
  expect(latestCalls).toBe(1)
})
