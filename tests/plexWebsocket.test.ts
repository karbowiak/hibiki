import { expect, mock, test } from "bun:test"
import { PlexWebSocketManager } from "../src/backends/plex/websocket"
import type { CatalogueChange } from "../src/offline/catalogue"
import { deferred, settle } from "./helpers/radioAudioFakes"
function harness(
  notify?: (changes: CatalogueChange[], catchUp: boolean) => Promise<void>,
  clock?: ReturnType<typeof virtualClock>
) {
  const sockets: {
    url: string
    onopen: (() => void) | null
    onmessage: ((event: { data: string }) => void) | null
    onclose: (() => void) | null
    onerror: (() => void) | null
    close: ReturnType<typeof mock>
  }[] = []
  const store = {
    setWsConnected: mock(() => {}),
    setLibraryScanning: mock(() => {}),
    invalidateLibraryTTLs: mock(() => {}),
    refreshAll: mock(async () => {}),
  }
  const manager = new PlexWebSocketManager(
    () => store as any,
    (url) => {
      const socket = {
        url,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close: mock(() => {}),
      }
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    notify,
    clock
  )
  return { manager, sockets, store }
}

function virtualClock() {
  let time = 100_000,
    serial = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => time,
    setTimeout(run: () => void, delay: number) {
      const id = ++serial
      timers.set(id, { at: time + delay, run })
      return id as any
    },
    clearTimeout(id: any) {
      timers.delete(id)
    },
    async advance(ms: number) {
      const end = time + ms
      for (let i = 0; i < 1000; i++) {
        const next = [...timers]
          .filter(([, job]) => job.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) {
          time = end
          await settle()
          return
        }
        time = next[1].at
        timers.delete(next[0])
        next[1].run()
        await settle()
      }
      throw Error("Unbounded socket timer loop")
    },
  }
}
function sendTimeline(
  socket: ReturnType<typeof harness>["sockets"][number],
  entries: any[]
) {
  socket.onmessage!({
    data: JSON.stringify({
      NotificationContainer: { type: "timeline", TimelineEntry: entries },
    }),
  })
}
const entry = (id: number | string, state = 5, extra: object = {}) => ({
  identifier: "com.plexapp.plugins.library",
  sectionID: 7,
  itemID: id,
  type: 10,
  state,
  ...extra,
})

test("catalogue hints survive active scans, coalesce latest state and ignore foreign/invalid identities", async () => {
  const clock = virtualClock(),
    notify = mock(async (_changes: CatalogueChange[], _catchUp: boolean) => {})
  const h = harness(notify, clock)
  h.manager.connect("https://server.test", "dummy-token", 7)
  h.sockets[0].onopen!()
  h.sockets[0].onmessage!({
    data: JSON.stringify({
      NotificationContainer: {
        type: "activity",
        ActivityNotification: [
          {
            event: "started",
            Activity: { type: "library.update.section", progress: 10 },
          },
        ],
      },
    }),
  })
  sendTimeline(h.sockets[0], [
    entry(42, 0),
    entry(42, 5),
    entry("43", 1, { sectionID: "7" }),
    entry(44, 9),
    entry(45, 5, { type: 8 }),
    entry(46, 5, { type: 9 }),
    entry(47, 5, { sectionID: 8 }),
    entry(48, 5, { type: 2 }),
    entry(-1),
    entry("9007199254740993"),
    entry(49, 3),
  ])
  await clock.advance(2000)
  expect(notify.mock.calls).toEqual([
    [
      [
        { id: 42, type: 10, state: 5 },
        { id: 43, type: 10, state: 1 },
        { id: 44, type: 10, state: 9 },
        { id: 45, type: 8, state: 5 },
        { id: 46, type: 9, state: 5 },
      ],
      true,
    ],
  ])
  expect(h.store.refreshAll).toHaveBeenCalledTimes(0)
  h.manager.disconnect()
})

test("failed admission retries without overwriting newer hints or losing reconnect catch-up", async () => {
  const clock = virtualClock(),
    pending = deferred<void>()
  const notify = mock((_changes: CatalogueChange[], _catchUp: boolean) =>
    notify.mock.calls.length === 1 ? pending.promise : Promise.resolve()
  )
  const h = harness(notify, clock)
  h.manager.connect("https://server.test", "dummy-token", 7)
  h.sockets[0].onopen!()
  sendTimeline(h.sockets[0], [entry(42, 0)])
  await clock.advance(2000)
  sendTimeline(h.sockets[0], [entry(42, 5), entry(43, 9)])
  pending.reject(Error("IPC temporarily unavailable"))
  await settle()
  await clock.advance(1000)
  expect(notify.mock.calls[1]).toEqual([
    [
      { id: 42, type: 10, state: 5 },
      { id: 43, type: 10, state: 9 },
    ],
    true,
  ])
  h.sockets[0].onclose!()
  await clock.advance(1000)
  h.sockets[1].onopen!()
  await clock.advance(2000)
  expect(notify.mock.calls.at(-1)).toEqual([[], true])
  h.manager.disconnect()
})

test("large bursts are bounded batches and overflow requests authoritative catch-up", async () => {
  const clock = virtualClock(),
    notify = mock(async (_changes: CatalogueChange[], _catchUp: boolean) => {})
  const h = harness(notify, clock)
  h.manager.connect("https://server.test", "dummy-token", 7)
  sendTimeline(
    h.sockets[0],
    Array.from({ length: 2100 }, (_, i) => entry(i + 1))
  )
  await clock.advance(2000)
  expect(notify.mock.calls.length).toBe(10)
  expect(notify.mock.calls.every(([changes]) => changes.length <= 200)).toBe(
    true
  )
  expect(
    new Set(notify.mock.calls.flatMap(([changes]) => changes.map((c) => c.id)))
      .size
  ).toBe(2000)
  expect(notify.mock.calls[0][1]).toBe(true)
  h.manager.disconnect()
})

test("an old in-flight notification cannot resurrect hints or unlock a new session's admission", async () => {
  const clock = virtualClock(),
    old = deferred<void>(),
    current = deferred<void>()
  const notify = mock((_changes: CatalogueChange[], _catchUp: boolean) =>
    notify.mock.calls.length === 1
      ? old.promise
      : notify.mock.calls.length === 2
        ? current.promise
        : Promise.resolve()
  )
  const h = harness(notify, clock)
  h.manager.connect("https://old.test", "dummy-old", 7)
  h.sockets[0].onopen!()
  sendTimeline(h.sockets[0], [entry(42)])
  await clock.advance(2000)
  h.manager.connect("https://new.test", "dummy-new", 7)
  h.sockets[1].onopen!()
  await clock.advance(2000)
  sendTimeline(h.sockets[1], [entry(43)])
  old.reject(Error("old admission failed"))
  await settle()
  await clock.advance(1000)
  expect(notify).toHaveBeenCalledTimes(2)
  current.resolve()
  await settle()
  await clock.advance(0)
  expect(notify.mock.calls[2]).toEqual([
    [{ id: 43, type: 10, state: 5 }],
    false,
  ])
  h.manager.disconnect()
})

test("scan completion requests catch-up even during the UI refresh cooldown", async () => {
  const clock = virtualClock(),
    notify = mock(async (_changes: CatalogueChange[], _catchUp: boolean) => {})
  const h = harness(notify, clock)
  h.manager.connect("https://server.test", "dummy-token", 7)
  sendTimeline(h.sockets[0], [entry(42)])
  await clock.advance(2000)
  h.sockets[0].onmessage!({
    data: JSON.stringify({
      NotificationContainer: {
        type: "activity",
        ActivityNotification: [
          { event: "ended", Activity: { type: "library.update.section" } },
        ],
      },
    }),
  })
  await clock.advance(2000)
  expect(notify.mock.calls.at(-1)).toEqual([[], true])
  h.manager.disconnect()
})

test("retired socket events cannot change the current connection or scanning status", () => {
  const { manager, sockets, store } = harness()
  manager.connect("https://old.test", "dummy-old", 1)
  const old = {
    open: sockets[0].onopen!,
    message: sockets[0].onmessage!,
    close: sockets[0].onclose!,
  }
  manager.connect("https://new.test", "dummy-new", 2)
  sockets[1].onopen!()
  const connects = store.setWsConnected.mock.calls.length
  old.close()
  old.open()
  old.message({
    data: JSON.stringify({
      NotificationContainer: {
        type: "activity",
        ActivityNotification: [
          {
            event: "started",
            Activity: { type: "library.update.section", progress: 25 },
          },
        ],
      },
    }),
  })
  expect(manager.isConnected).toBe(true)
  expect(store.setWsConnected).toHaveBeenCalledTimes(connects)
  expect(store.setLibraryScanning).toHaveBeenCalledTimes(0)
  expect(sockets[0].close).toHaveBeenCalledTimes(1)
  expect(sockets[0].onopen).toBeNull()
  manager.disconnect()
})

test("queued events after logout cannot restore socket state or trigger a library refresh", () => {
  const { manager, sockets, store } = harness()
  manager.connect("https://server.test", "dummy-token", 1)
  const open = sockets[0].onopen!,
    message = sockets[0].onmessage!,
    close = sockets[0].onclose!
  manager.disconnect()
  const scans = store.setLibraryScanning.mock.calls.length,
    connections = store.setWsConnected.mock.calls.length
  open()
  close()
  message({
    data: JSON.stringify({
      NotificationContainer: {
        type: "activity",
        ActivityNotification: [
          { event: "ended", Activity: { type: "library.update.section" } },
        ],
      },
    }),
  })
  expect(store.setWsConnected).toHaveBeenCalledTimes(connections)
  expect(store.setLibraryScanning).toHaveBeenCalledTimes(scans)
  expect(store.refreshAll).toHaveBeenCalledTimes(0)
  expect(manager.isConnected).toBe(false)
})

test("socket URLs preserve a reverse proxy prefix and encode tokens as one query value", () => {
  const { manager, sockets } = harness()
  manager.connect("https://example.test/plex/", "dummy&token+value", 1)
  const endpoint = new URL(sockets[0].url)
  expect(endpoint.protocol).toBe("wss:")
  expect(endpoint.pathname).toBe("/plex/:/websockets/notifications")
  expect([...endpoint.searchParams]).toEqual([
    ["X-Plex-Token", "dummy&token+value"],
  ])
  manager.disconnect()
})

test("a socket setup failure does not discard the authenticated connection", () => {
  const store = {
    setWsConnected: mock(() => {}),
    setLibraryScanning: mock(() => {}),
  }
  const manager = new PlexWebSocketManager(
    () => store as any,
    () => {
      throw new Error("Unavailable WebSocket")
    }
  )
  expect(() =>
    manager.connect("https://server.test", "dummy-token", 1)
  ).not.toThrow()
  expect(manager.isConnected).toBe(false)
  manager.disconnect()
})
