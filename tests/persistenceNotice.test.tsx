import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { PersistenceNotice } from "../src/components/PersistenceNotice"
import { deferred } from "./helpers/radioAudioFakes"

test("storage recovery keeps retry available after a failure and clears the notice on recovery", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://hibiki.example.test",
  })
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  }
  globalThis.document = dom.window.document
  globalThis.window = dom.window as unknown as Window & typeof globalThis
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById("root")!)
  try {
    let attempts = 0
    const first = deferred<void>()
    const issues = [
      {
        key: "radio-stream-v1",
        operation: "read" as const,
        hasPendingChanges: true,
      },
    ]
    const retry = () => (++attempts === 1 ? first.promise : Promise.resolve())
    await act(() =>
      root.render(<PersistenceNotice issues={issues} onRetry={retry} />)
    )
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "radio favorites and history"
    )
    expect(document.body.textContent).toContain(
      "New changes stay in this session"
    )
    expect(document.body.textContent).not.toContain("radio-stream-v1")
    const button = document.querySelector("button")!
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe("Retrying…")
    await act(async () => {
      first.reject(new Error("private storage exception"))
      await first.promise.catch(() => {})
    })
    expect(button.disabled).toBe(false)
    expect(document.body.textContent).not.toContain("private storage exception")
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(attempts).toBe(2)
    await act(() =>
      root.render(<PersistenceNotice issues={[]} onRetry={retry} />)
    )
    expect(document.querySelector('[role="status"]')).toBeNull()
  } finally {
    await act(() => root.unmount())
    globalThis.document = previous.document
    globalThis.window = previous.window
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
    dom.window.close()
  }
})
