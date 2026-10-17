import { useEffect, useRef, useState } from "react"
import clsx from "clsx"
import {
  IconGripVertical,
  IconChevronUp,
  IconChevronDown,
  IconSettings,
} from "@tabler/icons-react"
import {
  SOURCE_LABELS,
  SOURCE_DESCRIPTIONS,
  useMetadataSourceStore,
  type MetadataSource,
} from "../../stores/metadataSourceStore"
import { useSoulSyncStore } from "../../metadata/soulsync/store"
import {
  useFanartServiceStore,
  useHeyaServiceStore,
} from "../../metadata/services/store"
import { useTheAudioDbStore } from "../../metadata/theaudiodb/store"
import { useLastfmStore } from "../../metadata/lastfm/authStore"
import { MetadataSourceDialog } from "./MetadataSourceDialog"

export function MetadataPriorityList() {
  const { priority, setPriority } = useMetadataSourceStore()
  const [source, setSource] = useState<MetadataSource | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const soul = useSoulSyncStore((s) => s.status)
  const fanart = useFanartServiceStore((s) => s.status)
  const heya = useHeyaServiceStore((s) => s.status)
  const audio = useTheAudioDbStore((s) => s.status)
  const lastfmKey = useLastfmStore((s) => s.hasApiKey)
  useEffect(() => {
    void Promise.allSettled([
      useSoulSyncStore.getState().load(),
      useFanartServiceStore.getState().load(),
      useHeyaServiceStore.getState().load(),
      useTheAudioDbStore.getState().load(),
    ])
  }, [])
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= priority.length) return
    const next = [...priority]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setPriority(next)
  }
  function hovered(y: number) {
    return [...(list.current?.children ?? [])].findIndex((node) => {
      const rect = node.getBoundingClientRect()
      return y >= rect.top && y <= rect.bottom
    })
  }
  function status(item: MetadataSource) {
    const configured =
      item === "soulsync"
        ? soul
        : item === "fanart"
          ? fanart
          : item === "heya"
            ? heya
            : item === "theaudiodb"
              ? audio
              : undefined
    if (configured !== undefined)
      return !configured
        ? "Not loaded"
        : !configured.configured
          ? "Not configured"
          : configured.enabled
            ? "Enabled"
            : "Disabled"
    return item === "lastfm"
      ? lastfmKey
        ? "API key saved"
        : "No API key"
      : item === "plex"
        ? "Library"
        : "Public source"
  }
  return (
    <>
      <div
        ref={list}
        className="flex flex-col divide-y divide-(--border)"
        onPointerMove={(event) => {
          if (dragging !== null) {
            const index = hovered(event.clientY)
            if (index >= 0) setHover(index)
          }
        }}
        onPointerUp={(event) => {
          if (dragging !== null) {
            const index = hovered(event.clientY)
            if (index >= 0) move(dragging, index)
          }
          setDragging(null)
          setHover(null)
        }}
        onPointerCancel={() => {
          setDragging(null)
          setHover(null)
        }}
      >
        {priority.map((item, index) => (
          <div
            key={item}
            data-metadata-source={item}
            className={clsx(
              "flex flex-wrap items-center gap-3 py-4 transition-colors sm:flex-nowrap",
              dragging === index
                ? "bg-accent/15"
                : hover === index && dragging !== null
                  ? "bg-accent/10"
                  : "bg-transparent"
            )}
          >
            <button
              type="button"
              className="shrink-0 cursor-grab touch-none rounded-md p-1 text-(--text-muted) hover:text-(--text-primary) focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
              aria-label={`Reorder ${SOURCE_LABELS[item]}`}
              title="Drag, or use arrow keys to reorder"
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                list.current?.setPointerCapture(event.pointerId)
                setDragging(index)
                setHover(index)
              }}
              onKeyDown={(event) => {
                if (
                  ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault()
                  move(
                    index,
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? priority.length - 1
                        : index + (event.key === "ArrowUp" ? -1 : 1)
                  )
                }
              }}
            >
              <IconGripVertical size={16} />
            </button>
            <div className="min-w-0 flex-1 basis-36">
              <p className="text-sm font-medium">{SOURCE_LABELS[item]}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-(--text-muted)">
                {SOURCE_DESCRIPTIONS[item]}
              </p>
            </div>
            <span className="text-xs text-(--text-muted)">
              {status(item)}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => move(index, index - 1)}
                disabled={index === 0}
                aria-label={`Move ${SOURCE_LABELS[item]} up`}
                className="rounded-md p-1 text-(--text-muted) hover:bg-white/10 disabled:opacity-25"
              >
                <IconChevronUp size={15} />
              </button>
              <button
                type="button"
                onClick={() => move(index, index + 1)}
                disabled={index === priority.length - 1}
                aria-label={`Move ${SOURCE_LABELS[item]} down`}
                className="rounded-md p-1 text-(--text-muted) hover:bg-white/10 disabled:opacity-25"
              >
                <IconChevronDown size={15} />
              </button>
              <button
                type="button"
                onClick={() => setSource(item)}
                aria-label={`Configure ${SOURCE_LABELS[item]}`}
                className="ml-1 inline-flex items-center gap-1.5 rounded-lg border border-(--border) px-3 py-1.5 text-xs hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <IconSettings size={14} />
                Configure
              </button>
            </div>
          </div>
        ))}
      </div>
      {source && (
        <MetadataSourceDialog
          key={source}
          source={source}
          onClose={() => setSource(null)}
        />
      )}
    </>
  )
}
