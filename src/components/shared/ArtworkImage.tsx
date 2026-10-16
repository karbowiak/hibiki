import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react"

/** Native admission failures are transient; retry before declaring a source unavailable. */
export function ArtworkImage({
  src,
  onFailure,
  loading = "lazy",
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  src: string
  onFailure?: (url: string) => void
}) {
  // A keyed child gives every source a fresh retry budget and cancels old timers.
  return (
    <ImageAttempt
      key={src}
      src={src}
      onFailure={onFailure}
      loading={loading}
      {...props}
    />
  )
}
function ImageAttempt({
  src,
  onFailure,
  onLoad,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  src: string
  onFailure?: (url: string) => void
}) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [broken, setBroken] = useState(false)
  const recoveryRound = useRef(0)
  // Persistent surfaces such as the sidebar must recover after a temporary
  // disconnect or saturated native image queue, even if their URL is unchanged.
  // Galleries with an explicit fallback retain their existing source failover.
  useEffect(() => {
    if (!failed || onFailure) return
    const recover = () => {
      if (document.visibilityState === "hidden") return
      setAttempt(0)
      setBroken(false)
      setFailed(false)
    }
    const recovery = setTimeout(
      recover,
      Math.min(300_000, 60_000 * 2 ** recoveryRound.current++)
    )
    window.addEventListener("online", recover)
    window.addEventListener("focus", recover)
    document.addEventListener("visibilitychange", recover)
    return () => {
      clearTimeout(recovery)
      window.removeEventListener("online", recover)
      window.removeEventListener("focus", recover)
      document.removeEventListener("visibilitychange", recover)
    }
  }, [failed, onFailure])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )
  if (failed)
    return (
      <span
        className={`block ${props.className ?? ""}`}
        style={props.style}
        hidden={props.hidden}
        aria-hidden="true"
      />
    )
  return (
    <img
      key={attempt}
      {...props}
      style={{
        ...props.style,
        visibility: broken ? "hidden" : props.style?.visibility,
      }}
      src={src}
      onLoad={(event) => {
        setBroken(false)
        recoveryRound.current = 0
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
        onLoad?.(event)
      }}
      onError={() => {
        setBroken(true)
        if (timer.current !== null) return
        if (attempt >= 2) {
          setFailed(true)
          onFailure?.(src)
          return
        }
        timer.current = setTimeout(
          () => {
            timer.current = null
            setAttempt((value) => value + 1)
          },
          (attempt + 1) * 1000 + Math.floor(Math.random() * 250)
        )
      }}
    />
  )
}

/** Failed URLs belong to the current entity and connection-specific Plex URL. */
export function useArtworkFailures(scope: string) {
  const [state, setState] = useState<{ scope: string; urls: string[] }>({
    scope,
    urls: [],
  })
  const failures = state.scope === scope ? state.urls : []
  const onFailure = (url: string) =>
    setState((previous) => ({
      scope,
      urls:
        previous.scope === scope
          ? [...new Set([...previous.urls, url])]
          : [url],
    }))
  return { failures, onFailure }
}
