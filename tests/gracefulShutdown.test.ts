import { expect, test } from "bun:test"
import { GracefulShutdown } from "../src/lib/gracefulShutdown"
import { deferred, settle } from "./helpers/radioAudioFakes"

test("close handoff waits for native listen retention before preferences and shares duplicate requests", async () => {
  const native = deferred<void>()
  const events: string[] = []
  const shutdown = new GracefulShutdown({
    stopAndRetain: () => { events.push("native"); return native.promise },
    flushPreferences: async () => { events.push("preferences") },
    flushRemote: async () => { events.push("remote"); return { pending: 4 } },
  })
  const first = shutdown.prepare(), second = shutdown.prepare()
  expect(first).toBe(second)
  await settle()
  expect(events).toEqual(["native"])
  native.resolve()
  expect(await first).toEqual({ pending: 4 }) // Offline jobs are already durable.
  expect(events).toEqual(["native", "preferences", "remote"])
})

test("unsaved local changes prevent exit and a later retry can complete", async () => {
  let failing = true, remoteCalls = 0
  const shutdown = new GracefulShutdown({
    stopAndRetain: async () => {},
    flushPreferences: async () => { if (failing) throw new Error("Storage unavailable") },
    flushRemote: async () => { remoteCalls++; return { pending: 0 } },
  })
  await expect(shutdown.prepare()).rejects.toThrow("Storage unavailable")
  expect(remoteCalls).toBe(0)
  failing = false
  expect(await shutdown.prepare()).toEqual({ pending: 0 })
})

test("a missing acknowledgement times out without approving teardown", async () => {
  const native = deferred<void>()
  const shutdown = new GracefulShutdown({ stopAndRetain: () => native.promise, flushPreferences: async () => {}, flushRemote: async () => ({ pending: 0 }) }, 20)
  await expect(shutdown.prepare()).rejects.toThrow("window stayed open")
  native.resolve()
  await settle()
})

test("failed update download/install resets native approval and frozen playback admission", async () => {
  const { runPreparedUpdate } = await import("../src/lib/gracefulShutdown")
  for (const stage of ["download", "prepare", "install", "success"]) {
    let approved = false, frozen = false
    const events: string[] = []
    const operation = runPreparedUpdate({
      download: async () => { events.push("download"); if (stage === "download") throw new Error("download failed") },
      prepareExit: async () => { events.push("prepare"); frozen = true; if (stage === "prepare") throw new Error("preferences unsaved"); approved = true },
      install: async () => { events.push("install"); if (stage === "install") throw new Error("installation failed") },
      resume: async () => { events.push("resume"); approved = false; frozen = false },
    })
    if (stage === "success") await operation
    else await expect(operation).rejects.toThrow()
    expect(approved).toBe(false)
    expect(frozen).toBe(false)
    expect(events.at(-1)).toBe("resume")
    if (stage === "download") expect(events).toEqual(["download", "resume"])
    if (stage === "success") expect(events).toEqual(["download", "prepare", "install", "resume"])
  }
})
