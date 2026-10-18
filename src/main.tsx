import ReactDOM from "react-dom/client"
import { Profiler } from "react"
import { recordTiming } from "./lib/performance"
import { initializeClientStorage } from "./storage/clientStorage"
import { Button } from "./components/shared/Button"
import "./styles.css"
import "./App.css"

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement)
async function start() {
  root.render(<main className="flex h-screen items-center justify-center text-sm text-(--text-secondary)" role="status">Loading saved data…</main>)
  try {
    // Persisted modules hydrate during import. Prime the SQLite preference
    // snapshot before importing App so first paint uses the saved settings.
    await initializeClientStorage()
    const { default: App } = await import("./App")
    root.render(import.meta.env.DEV ? (
    <Profiler
      id="application"
      onRender={(_id, _phase, duration) =>
        recordTiming("renderer", "commit", duration)
      }
    >
      <App />
    </Profiler>
  ) : (
    <App />
  )
    )
  } catch (error) {
    console.error("Hibiki startup failed", error)
    root.render(<main className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center" role="alert">
      <h1 className="text-xl font-semibold">Saved data could not be loaded</h1>
      <p className="max-w-md text-sm text-(--text-secondary)">Could not open local storage. Retry to open Hibiki.</p>
      <Button onClick={() => void start()}>Retry</Button>
    </main>)
  }
}
void start()

if (import.meta.env.DEV) {
  let previous = performance.now()
  const heartbeat = setInterval(() => {
    const now = performance.now()
    const delayed = now - previous - 100
    if (document.visibilityState === "visible" && delayed > 100)
      recordTiming("renderer", "event_loop_delay", delayed)
    previous = now
  }, 100)
  import.meta.hot?.dispose(() => clearInterval(heartbeat))
}
