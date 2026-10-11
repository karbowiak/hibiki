import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { Router } from "wouter"

const location = () =>
  ["/settings", () => {}] as [string, (path: string) => void]

test("a failed manual connection preserves the attempt and explicit disconnect clears its token", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://hibiki.example.test",
  })
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
    storage: globalThis.localStorage,
  }
  globalThis.document = dom.window.document
  globalThis.window = dom.window as unknown as Window & typeof globalThis
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.localStorage = dom.window.localStorage
  const { PlexSettings } = await import("../src/backends/plex/settings")
  const { useConnectionStore } =
    await import("../src/backends/plex/connectionStore")
  const saved = useConnectionStore.getState()
  const url = "https://server.example.test"
  const token = "dummy-attempt-token"
  const attempts: unknown[][] = []
  useConnectionStore.setState({
    baseUrl: url,
    token,
    tlsExceptions: [url],
    isConnected: true,
    isLoading: false,
    error: null,
    needsLibraryPick: false,
    availableMusicSections: [],
    connect: async (...args) => {
      attempts.push(args)
      useConnectionStore.setState({
        baseUrl: "",
        token: "",
        tlsExceptions: [],
        isConnected: false,
        isLoading: true,
      })
      await Promise.resolve()
      useConnectionStore.setState({
        isLoading: false,
        error: "Could not connect",
      })
      throw new Error("Could not connect")
    },
    disconnectAndClear: async () => {
      useConnectionStore.setState({
        baseUrl: "",
        token: "",
        isConnected: false,
      })
    },
  })
  const root = createRoot(document.getElementById("root")!)
  try {
    await act(() =>
      root.render(
        <Router hook={location}>
          <PlexSettings />
        </Router>
      )
    )
    const manual = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("connect manually")
    )!
    await act(() => manual.click())
    const serverInput = document.getElementById(
      "plex-server-url"
    ) as HTMLInputElement
    const tokenInput = document.getElementById(
      "plex-server-token"
    ) as HTMLInputElement
    const trust = document.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement
    expect(serverInput.value).toBe(url)
    expect(tokenInput.value).toBe(token)
    expect(trust.checked).toBe(true)
    await act(async () => {
      document
        .querySelector("form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true })
        )
      await Promise.resolve()
    })
    expect(attempts[0]?.[0]).toBe(url)
    expect(attempts[0]?.[1]).toBe(token)
    expect(attempts[0]?.[4]).toBe(true)
    expect(serverInput.value).toBe(url)
    expect(tokenInput.value).toBe(token)
    expect(trust.checked).toBe(true)
    expect(document.body.textContent).toContain("Could not connect")
    await act(() =>
      useConnectionStore.setState({ baseUrl: url, token, isConnected: true })
    )
    const disconnect = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Disconnect"
    )!
    await act(async () => {
      disconnect.click()
      await Promise.resolve()
    })
    expect(
      (document.getElementById("plex-server-token") as HTMLInputElement | null)
        ?.value ?? ""
    ).toBe("")
    expect(useConnectionStore.getState().token).toBe("")
  } finally {
    await act(() => root.unmount())
    useConnectionStore.setState(saved, true)
    globalThis.document = previous.document
    globalThis.window = previous.window
    globalThis.localStorage = previous.storage
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
    dom.window.close()
  }
})
