import { expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { act, useRef } from "react"
import { createRoot } from "react-dom/client"
import { usePlaylistPagination } from "../src/hooks/usePlaylistPagination"

test("filtered playlist pagination requires explicit action and retires old listeners", async () => {
  const dom = new JSDOM("<div id='root'></div>")
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  }
  globalThis.window = dom.window as any
  globalThis.document = dom.window.document
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById("root")!)
  const calls: string[] = [],
    listeners: (() => void)[] = []
  const loadA = () => {
      calls.push("a")
    },
    loadB = () => {
      calls.push("b")
    }
  function Harness({
    id = "a",
    filter = "no matches",
    fetching = false,
    blocked = false,
  }: {
    id?: string
    filter?: string
    fetching?: boolean
    blocked?: boolean
  }) {
    const scroll = useRef<HTMLDivElement>(null),
      sentinel = useRef<HTMLDivElement>(null)
    const load = id === "a" ? loadA : loadB
    usePlaylistPagination({
      playlistId: id,
      scrollContainer: scroll,
      sentinel,
      isLoading: false,
      isFetchingMore: fetching,
      isFullyLoaded: false,
      filterQuery: filter,
      blocked,
      onLoadMore: load,
    })
    return (
      <div
        ref={(node) => {
          scroll.current = node
          if (node && !(node as any).instrumented) {
            ;(node as any).instrumented = true
            node.getBoundingClientRect = () => ({ bottom: 500 }) as DOMRect
            const add = node.addEventListener.bind(node)
            node.addEventListener = ((
              name: string,
              listener: () => void,
              options: any
            ) => {
              if (name === "scroll") listeners.push(listener)
              add(name, listener, options)
            }) as any
          }
        }}
        id="scroll"
      >
        <div
          ref={(node) => {
            sentinel.current = node
            if (node)
              node.getBoundingClientRect = () => ({ top: 100 }) as DOMRect
          }}
        />
        <button onClick={load}>Load more</button>
      </div>
    )
  }
  async function render(props: Parameters<typeof Harness>[0]) {
    await act(async () => root.render(<Harness {...props} />))
  }
  async function scroll() {
    await act(() =>
      document
        .getElementById("scroll")!
        .dispatchEvent(new dom.window.Event("scroll"))
    )
  }
  try {
    await render({})
    expect(calls).toEqual([])
    for (let i = 0; i < 3; i++) {
      await render({ fetching: true })
      await render({ fetching: false })
      await scroll()
    }
    expect(calls).toEqual([]) // no-match rows cannot create an automatic full-list drain
    await act(() =>
      document.querySelector<HTMLButtonElement>("button")!.click()
    )
    expect(calls).toEqual(["a"])
    await render({ filter: "" })
    expect(calls).toEqual(["a", "a"]) // ordinary unfiltered viewport fill remains supported
    await render({ filter: "", fetching: true })
    await scroll()
    expect(calls).toHaveLength(2)
    await render({ filter: "", blocked: true })
    await scroll()
    expect(calls).toHaveLength(2)
    const retired = listeners[0]!
    await render({ id: "b", filter: "" })
    expect(calls.at(-1)).toBe("b")
    const count = calls.length
    retired()
    expect(calls).toHaveLength(count)
    await act(() => root.unmount())
    listeners.at(-1)!()
    expect(calls).toHaveLength(count)
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act
    dom.window.close()
  }
})
