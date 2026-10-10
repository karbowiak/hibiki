import { expect, mock, test } from "bun:test"
import { PlexWebSocketManager } from "../src/backends/plex/websocket"
function harness() {
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
    refreshAll: mock(async () => {})
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
        close: mock(() => {})
      }
      sockets.push(socket)
      return socket as unknown as WebSocket
    }
  )
  return { manager, sockets, store }
}

test("retired socket events cannot change the current connection or scanning status", () => {
  const { manager, sockets, store } = harness()
  manager.connect("https://old.test", "dummy-old", 1)
  const old = { open: sockets[0].onopen!, message: sockets[0].onmessage!, close: sockets[0].onclose! }
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
          { event: "started", Activity: { type: "library.update.section", progress: 25 } }
        ]
      }
    })
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
        ActivityNotification: [{ event: "ended", Activity: { type: "library.update.section" } }]
      }
    })
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
  expect([...endpoint.searchParams]).toEqual([["X-Plex-Token", "dummy&token+value"]])
  manager.disconnect()
})

test("a socket setup failure does not discard the authenticated connection", () => {
  const store = { setWsConnected: mock(() => {}), setLibraryScanning: mock(() => {}) }
  const manager = new PlexWebSocketManager(
    () => store as any,
    () => {
      throw new Error("Unavailable WebSocket")
    }
  )
  expect(() => manager.connect("https://server.test", "dummy-token", 1)).not.toThrow()
  expect(manager.isConnected).toBe(false)
  manager.disconnect()
})
