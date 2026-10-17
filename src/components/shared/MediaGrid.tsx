import {
  Children,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react"
import { useVirtualWindow, virtualRef } from "../../hooks/useVirtualWindow"
import type { WindowedCollection } from "../../lib/windowedPages"
import { Skeleton } from "./Skeleton"

interface MediaGridProps<T> {
  gap?: 3 | 4
  children?: ReactNode
  className?: string
  paged?: WindowedCollection<T>
  renderItem?: (item: T, index: number) => ReactNode
}

export function MediaGrid<T>({
  gap = 4,
  children,
  className,
  paged,
  renderItem,
}: MediaGridProps<T>) {
  const items = Children.toArray(children)
  const count = paged?.total ?? items.length
  const [columns, setColumns] = useState(1)
  const window = useVirtualWindow(count, 200 + gap * 4, columns, count > 80)
  useEffect(() => {
    paged?.ensureRange(window.start, window.end)
  }, [paged, window.start, window.end])
  useLayoutEffect(() => {
    const element = window.host.current
    if (!element || typeof ResizeObserver === "undefined") return
    const update = () =>
      setColumns(
        getComputedStyle(element).gridTemplateColumns.split(" ").length
      )
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [window.host])
  return (
    <div
      ref={virtualRef<HTMLDivElement>(window.host)}
      role="list"
      className={`grid ${gap === 3 ? "gap-3" : "gap-4"}${className ? ` ${className}` : ""}`}
      style={{
        gridTemplateColumns:
          "repeat(auto-fill, minmax(var(--card-size, 160px), 1fr))",
        overflowAnchor: "none",
      }}
    >
      {window.before > 0 && (
        <div
          aria-hidden="true"
          style={{
            gridColumn: "1 / -1",
            height: Math.max(0, window.before - gap * 4),
          }}
        />
      )}
      {Array.from(
        { length: Math.max(0, window.end - window.start) },
        (_, index) => {
          const position = window.start + index
          const value = paged?.getItem(position)
          const item = paged ? (
            value ? (
              renderItem?.(value, position)
            ) : (
              <Skeleton className="aspect-square w-full rounded-xl" />
            )
          ) : (
            items[position]
          )
          return (
            <div
              key={(item as { key?: string })?.key ?? position}
              role="listitem"
              aria-posinset={position + 1}
              aria-setsize={count}
              data-media-index={position}
              ref={
                index === 0
                  ? virtualRef<HTMLDivElement>(window.measure)
                  : undefined
              }
              style={{
                display: "grid",
                alignContent: "start",
                paddingBottom: gap * 4,
                marginBottom: -gap * 4,
                minWidth: 0,
              }}
            >
              {item}
            </div>
          )
        }
      )}
      {window.after > 0 && (
        <div
          aria-hidden="true"
          style={{
            gridColumn: "1 / -1",
            height: Math.max(0, window.after - gap * 4),
          }}
        />
      )}
    </div>
  )
}
