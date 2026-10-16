import { useEffect } from "react"
import { AppDialog } from "./shared/AppDialog"
import { IS_MACOS } from "../lib/platform"
import { isCompositionKey } from "../lib/keyboard"

const mod = IS_MACOS ? "Cmd" : "Ctrl"

interface Hotkey {
  key: string
  action: string
}

interface HotkeyGroup {
  title: string
  hotkeys: Hotkey[]
}

const playbackGroup: HotkeyGroup = {
  title: "Playback",
  hotkeys: [
    { key: "Space", action: "Play / Pause" },
    { key: "N", action: "Next track" },
    { key: "B", action: "Previous track" },
    { key: "\u2190 / \u2192", action: "Seek \u00b15 seconds" },
    { key: "Shift + \u2190 / \u2192", action: "Seek \u00b115 seconds" },
    { key: "\u2191 / \u2193", action: "Volume up / down" },
    { key: "M", action: "Mute / Unmute" },
    { key: "S", action: "Toggle shuffle" },
    { key: "R", action: "Cycle repeat mode" },
  ],
}

const navigationGroup: HotkeyGroup = {
  title: "Navigation",
  hotkeys: [
    { key: `${mod} + F`, action: "Focus search" },
    { key: `${mod} + K`, action: "Focus search" },
    { key: `${mod} + R`, action: "Refresh library" },
    { key: "V", action: "Open visualizer" },
    { key: "?", action: "Toggle this help" },
  ],
}

const visualizerGroup: HotkeyGroup = {
  title: "Visualizer",
  hotkeys: [
    { key: "Escape", action: "Close visualizer" },
    { key: "1 \u2013 5", action: "Switch visualizer mode" },
  ],
}

const milkdropGroup: HotkeyGroup = {
  title: "MilkDrop",
  hotkeys: [
    { key: "\u2190 / \u2192", action: "Previous / Next preset" },
    { key: "B", action: "Browse presets" },
    { key: "R", action: "Random preset" },
    { key: "F", action: "Favorite preset" },
  ],
}

interface Props {
  context?: "player" | "visualizer"
  onClose: () => void
}

export function HotkeyHelpModal({ context = "player", onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.repeat || isCompositionKey(e)) return
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [onClose])

  const groups =
    context === "visualizer"
      ? [playbackGroup, visualizerGroup, milkdropGroup]
      : [playbackGroup, navigationGroup]

  return (
    <AppDialog title="Keyboard Shortcuts" onClose={onClose} className="max-w-lg">
        <div className="space-y-5">
          {groups.map(group => (
            <div key={group.title}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">
                {group.title}
              </h3>
              <div className="space-y-1">
                {group.hotkeys.map(hotkey => (
                  <div
                    key={hotkey.key}
                    className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-white/5"
                  >
                    <span className="text-[color:var(--text-secondary)]">{hotkey.action}</span>
                    <kbd className="rounded border border-[var(--border)] bg-app-surface px-2 py-0.5 font-mono text-xs text-[color:var(--text-primary)]">
                      {hotkey.key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
    </AppDialog>
  )
}
