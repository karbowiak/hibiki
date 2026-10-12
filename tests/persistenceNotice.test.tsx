import { expect, mock, test } from "bun:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import {
  PreferencePersistence,
  type PersistenceIssue,
} from "../src/stores/preferencePersistence"
import { deferred, settle } from "./helpers/radioAudioFakes"

// Separate processes keep synthetic preference services out of other mounted tests.
if (process.argv[2] === "--fixture") {
  await fixture(process.argv[3]!)
} else {
  for (const scenario of [
    "retry-recovery",
    "mixed-operations",
    "aggregate-sources",
    "unmount-owner",
  ]) {
    test(`headless preference storage notice: ${scenario}`, async () => {
      const child = Bun.spawn(
        [process.execPath, import.meta.path, "--fixture", scenario],
        { stdout: "pipe", stderr: "pipe" }
      )
      const [status, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ status, output: output + errors }).toEqual({
        status: 0,
        output: "",
      })
    })
  }
}

async function fixture(scenario: string) {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://synthetic.test",
  })
  globalThis.document = dom.window.document
  globalThis.window = dom.window as any
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  let root = createRoot(document.getElementById("root")!)
  let mounted = true
  function service() {
    const values = new Map<string, string>()
    const backend = {
      failing: true,
      barrier: null as ReturnType<typeof deferred<void>> | null,
      get: (key: string) => values.get(key),
      update: async (key: string, transform: (raw: unknown) => string) => {
        if (backend.barrier) await backend.barrier.promise
        if (backend.failing)
          throw new Error("synthetic private storage exception")
        values.set(key, transform(values.get(key)))
      },
      remove: (key: string) => {
        values.delete(key)
      },
    }
    const persistence = new PreferencePersistence(backend)
    let subscribers = 0
    const subscribe = persistence.subscribe
    persistence.subscribe = (callback) => {
      subscribers++
      const cleanup = subscribe(callback)
      return () => {
        subscribers--
        cleanup()
      }
    }
    return { persistence, backend, values, subscribers: () => subscribers }
  }
  const idb = service(),
    local = service()
  mock.module("../src/stores/idbStorage", () => ({
    preferencePersistence: idb.persistence,
  }))
  mock.module("../src/stores/localPreferenceStorage", () => ({
    localPreferencePersistence: local.persistence,
  }))
  const { useNotificationCenterStore: notices } =
    await import("../src/stores/notificationCenterStore")
  const { PersistenceNotice, StorageStatus } =
    await import("../src/components/PersistenceNotice")
  const entry = () =>
    notices
      .getState()
      .notifications.find((item) => item.id === "storage.preferences")!
  const run = () => notices.getState().runAction("storage.preferences")
  async function render(
    issues: PersistenceIssue[],
    retry: () => Promise<void>
  ) {
    await act(async () => {
      root.render(<PersistenceNotice issues={issues} onRetry={retry} />)
      await settle()
    })
  }
  async function writeFailure(target: ReturnType<typeof service>, key: string) {
    const session = target.persistence.register(key)
    await session.read()
    session.baseline({ value: 0 })
    session.hydrated()
    await session.stage({ value: 1 })
  }
  try {
    if (scenario === "retry-recovery") {
      let attempts = 0
      const first = deferred<void>()
      const issues: PersistenceIssue[] = [
        { key: "radio-stream-v1", operation: "read", hasPendingChanges: true },
      ]
      const retry = () => (++attempts === 1 ? first.promise : Promise.resolve())
      await render(issues, retry)
      assert.equal(entry().severity, "error")
      assert.match(entry().message, /radio favorites and history/)
      assert.match(entry().message, /New changes stay in this session/)
      assert.match(entry().message, /Retry before closing Hibiki/)
      assert.ok(!entry().message.includes("radio-stream-v1"))
      let firstRun!: Promise<void>
      await act(async () => {
        firstRun = run()
        await settle()
      })
      assert.equal(entry().actionPending, true)
      assert.equal(
        run(),
        firstRun,
        "panel/toast retries must share one pending action"
      )
      const rejected = firstRun.then(
        () => {
          throw new Error("retry unexpectedly succeeded")
        },
        (error) => error
      )
      await act(async () => {
        first.reject(new Error("private storage exception"))
        await settle()
      })
      assert.ok(!(await rejected).message.includes("private storage exception"))
      assert.equal(entry().actionPending, false)
      assert.equal(entry().active, true)
      assert.equal(entry().action!.label, "Retry")
      await act(async () => {
        await run()
      })
      assert.equal(attempts, 2)
      assert.equal(
        entry().active,
        true,
        "resolved retry promise alone cannot claim storage recovered"
      )
      await render([], retry)
      assert.equal(entry().active, false)
      assert.equal(entry().action, undefined)
      assert.equal(entry().toastVisible, false)
      assert.equal(
        notices.getState().notifications.length,
        1,
        "recovery preserves notice history"
      )
    } else if (scenario === "mixed-operations") {
      const retry = async () => {}
      await render(
        [
          {
            key: "unknown-private-key",
            operation: "read",
            hasPendingChanges: false,
          },
        ],
        retry
      )
      assert.equal(entry().severity, "warning")
      assert.match(entry().message, /existing saved data is protected/)
      assert.match(entry().message, /saved preferences/)
      assert.ok(!entry().message.includes("unknown-private-key"))
      await render(
        [
          {
            key: "podcast-store-v1",
            operation: "read",
            hasPendingChanges: false,
          },
          {
            key: "plex-player-prefs",
            operation: "write",
            hasPendingChanges: true,
          },
        ],
        retry
      )
      assert.equal(
        entry().severity,
        "error",
        "an unrelated read issue must not mask unsaved writes"
      )
      assert.match(entry().message, /Changes are kept in this session/)
      assert.match(entry().message, /Retry before closing Hibiki/)
      assert.match(
        entry().message,
        /podcast subscriptions and progress, playback preferences/
      )
      await render(
        [
          {
            key: "deezer-metadata-v1",
            operation: "remove",
            hasPendingChanges: false,
          },
        ],
        retry
      )
      assert.equal(entry().severity, "warning")
      assert.match(entry().message, /could not be cleared/)
      assert.match(entry().message, /metadata cache/)
    } else {
      await writeFailure(idb, "radio-stream-v1")
      await writeFailure(local, "plex-audio-settings-v1")
      await act(async () => {
        root.render(<StorageStatus />)
        await settle()
      })
      assert.equal(idb.subscribers(), 1)
      assert.equal(local.subscribers(), 1)
      assert.match(
        entry().message,
        /radio favorites and history, audio preferences/
      )
      idb.backend.failing = false
      idb.backend.barrier = deferred<void>()
      local.backend.barrier = deferred<void>()
      let pending!: Promise<void>
      await act(async () => {
        pending = run()
        await settle()
      })
      assert.equal(entry().actionPending, true)
      await act(async () => {
        idb.backend.barrier!.resolve()
        await settle()
      })
      assert.equal(idb.persistence.snapshot().length, 0)
      assert.equal(local.persistence.snapshot().length, 1)
      assert.equal(
        entry().active,
        true,
        "one recovered backend must not clear another's unsaved edits"
      )
      assert.equal(
        entry().actionPending,
        true,
        "action remains pending until both services settle"
      )
      assert.ok(!entry().message.includes("radio favorites"))
      if (scenario === "unmount-owner") {
        await act(async () => root.unmount())
        mounted = false
        assert.equal(idb.subscribers(), 0)
        assert.equal(local.subscribers(), 0)
        assert.equal(
          entry().active,
          true,
          "unmount must not falsely clear an unresolved issue"
        )
      }
      await act(async () => {
        local.backend.barrier!.resolve()
        await pending
        await settle()
      })
      assert.equal(entry().actionPending, false)
      assert.equal(entry().active, true)
      assert.equal(local.persistence.snapshot().length, 1)
      assert.ok(!entry().message.includes("private storage exception"))
      if (!mounted) {
        root = createRoot(document.getElementById("root")!)
        mounted = true
        await act(async () => {
          root.render(<StorageStatus />)
          await settle()
        })
      }
      local.backend.failing = false
      await act(async () => {
        await run()
        await settle()
      })
      assert.equal(local.persistence.snapshot().length, 0)
      assert.equal(entry().active, false)
      assert.equal(entry().toastVisible, false)
      assert.equal(notices.getState().notifications.length, 1)
    }
    assert.equal(
      document.getElementById("root")!.innerHTML,
      "",
      "no storage banner may render"
    )
  } finally {
    if (mounted) await act(async () => root.unmount())
    dom.window.close()
  }
}
