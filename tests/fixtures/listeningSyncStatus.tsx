import { mock } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { Router } from "wouter"
import { deferred, settle } from "../helpers/radioAudioFakes"
const scenario = process.argv[2]!
const dom = new JSDOM("<div id='root'></div>", {
  url: "https://synthetic.test",
})
globalThis.window = dom.window as any
globalThis.document = dom.window.document
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import("react-dom/client")
const root = createRoot(document.getElementById("root")!)
let poll: () => void
const originalInterval = globalThis.setInterval,
  originalClear = globalThis.clearInterval
globalThis.setInterval = ((callback: () => void) => {
  poll = callback
  return 1
}) as any
globalThis.clearInterval = (() => {}) as any
const requests: { command: string; reply: ReturnType<typeof deferred<any>> }[] =
  []
mock.module("@tauri-apps/api/core", () => ({
  invoke(command: string) {
    const reply = deferred<any>()
    requests.push({ command, reply })
    return reply.promise
  },
}))
const { useNotificationCenterStore: notices } =
  await import("../../src/stores/notificationCenterStore")
const { ListeningSyncStatus } =
  await import("../../src/components/ListeningSyncStatus")
const navigated: string[] = []
const location = () =>
  [
    "/",
    (path: string) => {
      navigated.push(path)
    },
  ] as const
const quiet = {
  pending: 0,
  unretained: 0,
  save_failed: false,
  waiting_for_account: 0,
  retrying: 0,
  delayed: 0,
}
const active = () =>
  notices.getState().notifications.filter((entry) => entry.active)
const entry = (id: string) => active().find((item) => item.id === id)!
async function answer(index: number, value: any) {
  await act(async () => {
    requests[index]!.reply.resolve(value)
    await settle()
  })
}
async function tick() {
  await act(async () => {
    poll()
    await settle()
  })
}
let action: Promise<void> | void
async function retry() {
  await act(async () => {
    action = entry("listening.sync").action!.run()
    await settle()
  })
}
try {
  await act(async () => {
    root.render(
      <Router hook={location}>
        <ListeningSyncStatus />
      </Router>
    )
    await settle()
  })
  assert.equal(requests[0]!.command, "listening_history_status")
  if (["normal", "saving", "transient"].includes(scenario)) {
    await answer(0, {
      ...quiet,
      pending: 4,
      unretained: scenario === "saving" ? 1 : 0,
      retrying: scenario === "transient" ? 1 : 0,
    })
    assert.equal(active().length, 0, "ordinary delivery must stay quiet")
  } else if (scenario === "unsafe") {
    await answer(0, { ...quiet, unretained: 1, save_failed: true })
    assert.equal(
      entry("listening.storage").title,
      "Listening history could not be saved"
    )
    assert.match(entry("listening.storage").message, /Keep Hibiki open/)
    assert.equal(entry("listening.storage").severity, "error")
    assert.equal(entry("listening.storage").action!.label, "Retry")
  } else if (scenario === "account") {
    await answer(0, { ...quiet, pending: 3, waiting_for_account: 3 })
    assert.match(entry("listening.accounts").message, /saved.*isn’t active/)
    assert.equal(entry("listening.accounts").severity, "info")
    assert.equal(entry("listening.accounts").action!.label, "Settings")
    await act(async () => entry("listening.accounts").action!.run())
    assert.deepEqual(navigated, ["/settings"])
    assert.equal(
      requests.length,
      1,
      "account action must not submit history to another account"
    )
    assert.equal(entry("listening.storage"), undefined)
  } else if (scenario === "status-error" || scenario === "status-recovery") {
    await act(async () => {
      requests[0]!.reply.reject(new Error("synthetic unavailable query"))
      await settle()
    })
    assert.equal(
      entry("listening.status").title,
      "Listening status unavailable"
    )
    assert.equal(
      entry("listening.storage"),
      undefined,
      "failed query is not proof of lost persistence"
    )
    if (scenario === "status-recovery") {
      let checking: void | Promise<void>
      await act(async () => {
        checking = entry("listening.status").action!.run()
        await settle()
      })
      assert.equal(
        requests[1]!.command,
        "listening_history_status",
        "status check must not resubmit listens"
      )
      await answer(1, quiet)
      await checking!
      assert.equal(active().length, 0)
    }
  } else if (scenario === "retry-error") {
    await answer(0, { ...quiet, pending: 1, delayed: 1, retrying: 1 })
    await retry()
    const caught = (action as Promise<void>).then(
      () => {
        throw new Error("failed retry unexpectedly succeeded")
      },
      (error) => error
    )
    await act(async () => {
      requests[1]!.reply.reject(new Error("synthetic private upstream body"))
      await settle()
    })
    assert.match((await caught).message, /could not be retried/)
    assert.ok(
      !JSON.stringify(notices.getState().notifications).includes(
        "private upstream body"
      )
    )
    assert.equal(
      entry("listening.status").title,
      "Listening status unavailable"
    )
    assert.equal(
      entry("listening.sync").active,
      true,
      "failed retry must retain the known delivery problem"
    )
  } else if (scenario === "poll-overlap") {
    await tick()
    await tick()
    assert.equal(requests.length, 1, "polls must not overlap")
    await answer(0, quiet)
    await tick()
    assert.equal(requests.length, 2)
    const delayed = { ...quiet, pending: 1, delayed: 1, retrying: 1 }
    await answer(1, delayed)
    assert.match(
      entry("listening.sync").message,
      /saved locally.*retry automatically/
    )
    const revision = entry("listening.sync").toastRevision
    notices.getState().dismissToast("listening.sync")
    await tick()
    await answer(2, delayed)
    assert.equal(
      entry("listening.sync").toastRevision,
      revision,
      "repeated polls must not re-toast"
    )
    assert.equal(entry("listening.sync").toastVisible, false)
    await tick()
    await answer(3, quiet)
    assert.equal(active().length, 0)
    assert.equal(
      notices.getState().notifications.length,
      1,
      "recovery keeps history"
    )
  } else {
    await answer(0, { ...quiet, pending: 1, delayed: 1, retrying: 1 })
    if (scenario === "retry-race") await tick()
    const retryIndex = requests.length
    await retry()
    const firstAction = action
    await retry()
    await tick()
    assert.equal(
      requests.length,
      retryIndex + 1,
      "retry must deduplicate and suppress polling"
    )
    assert.equal(requests[retryIndex]!.command, "retry_listening_history")
    if (scenario === "unmount-retry") {
      await act(async () => root.unmount())
      await answer(retryIndex, {})
      await firstAction
      assert.equal(
        requests.length,
        retryIndex + 1,
        "retired retry must not issue another status query"
      )
    } else {
      await answer(retryIndex, {})
      assert.equal(
        requests[retryIndex + 1]!.command,
        "listening_history_status"
      )
      await answer(retryIndex + 1, quiet)
      await firstAction
      assert.equal(active().length, 0)
      await act(async () => {
        requests[1]!.reply.reject(new Error("retired poll"))
        await settle()
      })
      assert.equal(
        active().length,
        0,
        "old poll must not overwrite recovered retry"
      )
    }
  }
  assert.equal(
    document.getElementById("root")!.innerHTML,
    "",
    "publisher must not render a banner"
  )
  if (scenario !== "unmount-retry") await act(async () => root.unmount())
} finally {
  globalThis.setInterval = originalInterval
  globalThis.clearInterval = originalClear
  dom.window.close()
}
