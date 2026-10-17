import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

const wrapper = readFileSync(
  new URL("../src-tauri/src/ytmusic/main_window_plugin.js", import.meta.url),
  "utf8"
)

describe("native notification plugin scope", () => {
  for (const label of ["youtube-music-session", undefined]) {
    test(`leaves website browser APIs alone (${label ?? "missing metadata"})`, () => {
      const browserNotification = function Notification() {}
      let calls = 0
      const window = {
        Notification: browserNotification,
        __TAURI_INTERNALS__: {
          metadata: label ? { currentWebview: { label } } : undefined,
          invoke: () => {
            calls++
          },
        },
      }
      runInNewContext(
        wrapper.replace(
          "__HIBIKI_PLUGIN_SCRIPT__",
          `
        window.Notification = function NativeNotification() {};
        window.__TAURI_INTERNALS__.invoke("plugin:notification|is_permission_granted");
      `
        ),
        { window }
      )
      expect(window.Notification).toBe(browserNotification)
      expect(calls).toBe(0)
    })
  }

  test("still initializes native notifications in the main player", () => {
    const browserNotification = function Notification() {}
    const calls: string[] = []
    const window = {
      Notification: browserNotification,
      __TAURI_INTERNALS__: {
        metadata: { currentWebview: { label: "main" } },
        invoke: (command: string) => {
          calls.push(command)
        },
      },
    }
    runInNewContext(
      wrapper.replace(
        "__HIBIKI_PLUGIN_SCRIPT__",
        `
      window.Notification = function NativeNotification() {};
      window.__TAURI_INTERNALS__.invoke("plugin:notification|is_permission_granted");
    `
      ),
      { window }
    )
    expect(window.Notification).not.toBe(browserNotification)
    expect(calls).toEqual(["plugin:notification|is_permission_granted"])
  })
})
