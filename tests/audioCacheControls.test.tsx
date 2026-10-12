import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  AudioCacheControls,
  type AudioCacheBackend,
} from "../src/components/AudioCacheControls"
import type { AudioCacheStats } from "../src/audio/RustAudioEngine"
import { deferred, settle } from "./helpers/radioAudioFakes"

const GIB = 1024 ** 3
const initial: AudioCacheStats = {
  total_bytes: 2048,
  file_count: 2,
  max_bytes: 5 * GIB,
  status: "ready",
}

async function withControls(
  backend: AudioCacheBackend,
  change: (bytes: number) => Promise<AudioCacheStats>,
  check: () => Promise<void>
) {
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
  function Harness() {
    const [maximum, setMaximum] = useState(5 * GIB)
    return (
      <AudioCacheControls
        backend={backend}
        maximum={maximum}
        onMaximumChange={async (bytes) => {
          const stats = await change(bytes)
          setMaximum(stats.max_bytes)
          return stats
        }}
      />
    )
  }
  try {
    await act(async () => {
      root.render(<Harness />)
      await settle()
    })
    await check()
  } finally {
    await act(() => root.unmount())
    globalThis.document = previous.document
    globalThis.window = previous.window
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
    dom.window.close()
  }
}

test("cache Clear stays pending for native completion and cannot be submitted twice", async () => {
  const response = deferred<AudioCacheStats>()
  let clears = 0
  await withControls(
    {
      getCacheStats: async () => initial,
      clearCache: () => {
        ++clears
        return response.promise
      },
    },
    async () => initial,
    async () => {
      const button = document.querySelector("button")!
      await act(async () => {
        button.click()
        button.click()
        await settle()
      })
      expect(clears).toBe(1)
      expect(button.textContent).toBe("Clearing...")
      expect(button.disabled).toBe(true)
      expect(document.querySelector("select")!.disabled).toBe(true)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
      })
      expect(button.textContent).toBe("Clearing...")
      await act(async () => {
        response.resolve({ ...initial, file_count: 0, total_bytes: 0 })
        await settle()
      })
      expect(document.body.textContent).toContain("0 tracks")
      expect(button.textContent).toBe("Clear")
      expect(button.disabled).toBe(true)
    }
  )
})

test("failed cache Clear shows the error and leaves retry available", async () => {
  let clears = 0
  await withControls(
    {
      getCacheStats: async () => initial,
      clearCache: async () => {
        if (++clears === 1) throw new Error("storage unavailable")
        return { ...initial, total_bytes: 0, file_count: 0 }
      },
    },
    async () => initial,
    async () => {
      const button = document.querySelector("button")!
      await act(async () => {
        button.click()
        await settle()
      })
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "storage unavailable"
      )
      expect(button.disabled).toBe(false)
      await act(async () => {
        button.click()
        await settle()
      })
      expect(clears).toBe(2)
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.body.textContent).toContain("0 tracks")
    }
  )
})

test("a slow initial usage reply cannot overwrite an acknowledged limit change", async () => {
  const loading = deferred<AudioCacheStats>()
  const applying = deferred<AudioCacheStats>()
  const requested: number[] = []
  await withControls(
    { getCacheStats: () => loading.promise, clearCache: async () => initial },
    (bytes) => {
      requested.push(bytes)
      return applying.promise
    },
    async () => {
      const select = document.querySelector("select")!
      await act(async () => {
        select.value = String(10 * GIB)
        select.dispatchEvent(new window.Event("change", { bubbles: true }))
        await settle()
      })
      expect(requested).toEqual([10 * GIB])
      expect(select.disabled).toBe(true)
      await act(async () => {
        applying.resolve({ ...initial, max_bytes: 10 * GIB, file_count: 1 })
        await settle()
      })
      expect(select.value).toBe(String(10 * GIB))
      expect(document.body.textContent).toContain("1 track")
      await act(async () => {
        loading.resolve({ ...initial, file_count: 8 })
        await settle()
      })
      expect(document.body.textContent).not.toContain("8 tracks")
      expect(document.body.textContent).toContain("1 track")
    }
  )
})
