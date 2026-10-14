import ReactDOM from "react-dom/client"
import { Profiler } from "react"
import { recordTiming } from "./lib/performance"
import App from "./App"
import "./styles.css"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? (
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
