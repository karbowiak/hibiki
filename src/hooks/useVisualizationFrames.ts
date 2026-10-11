import { useEffect } from "react"

/** Repaint a static canvas once; own and cancel recurring work across every rerender. */
export function useVisualizationFrames(
  draw: () => void,
  animate: boolean,
  visible: boolean
) {
  useEffect(() => {
    if (!visible) return
    let active = true
    let frame = 0
    const render = () => {
      if (!active) return
      draw()
      if (animate && active) frame = requestAnimationFrame(render)
    }
    render()
    return () => {
      active = false
      cancelAnimationFrame(frame)
    }
  }, [draw, animate, visible])
}
