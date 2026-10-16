import { useSyncExternalStore } from "react"
import { IconMoon, IconSun } from "@tabler/icons-react"
import { getTheme, setTheme, subscribeTheme } from "../stores/themeStore"

function subscribe(listener: () => void) {
  const unsubscribe = subscribeTheme(listener)
  const media = window.matchMedia?.("(prefers-color-scheme: light)")
  media?.addEventListener("change", listener)
  return () => { unsubscribe(); media?.removeEventListener("change", listener) }
}
function snapshot() {
  return document.documentElement.getAttribute("data-theme") === "light"
}
/** Uses the same saved preference as Appearance, including system-theme changes. */
export function ThemeToggle() {
  const light = useSyncExternalStore(subscribe, snapshot, () => getTheme() === "light")
  const label = `Switch to ${light ? "dark" : "light"} mode`
  return <button
    type="button"
    aria-label={label}
    title={label}
    className="topbar-control topbar-icon-control shell-control-secondary rounded-full"
    onClick={() => setTheme(light ? "dark" : "light")}
  >
    {light ? <IconMoon size={17} aria-hidden="true" /> : <IconSun size={17} aria-hidden="true" />}
  </button>
}
