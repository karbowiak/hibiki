import { useEffect, useState, type CSSProperties } from "react"
import { artworkToneSampler, type ArtworkTone } from "../lib/artworkTone"
import { useProviderStore } from "../stores/providerStore"
import { useArtworkAppearanceStore } from "../stores/artworkAppearanceStore"
/** Colors remain local to the artwork consumer, never the global accent. */
export function useArtworkTone(src: string | null): CSSProperties | undefined {
  const enabled = useArtworkAppearanceStore(
    (state) => state.artworkColorsEnabled
  )
  const provider = useProviderStore((state) => state.provider),
    scope = provider?.cacheScope
  const key = `${scope ?? ""}\0${src ?? ""}`
  const [result, setResult] = useState<{
    src: string
    provider: typeof provider
    scope: typeof scope
    tone: ArtworkTone
  } | null>(null)
  useEffect(() => {
    if (!enabled || !src) return
    let current = true
    const original = provider,
      originalScope = scope
    void artworkToneSampler.sample(src, key).then((tone) => {
      if (
        current &&
        tone &&
        useProviderStore.getState().provider === original &&
        original?.cacheScope === originalScope
      )
        setResult({ src, provider: original, scope: originalScope, tone })
    })
    return () => {
      current = false
    }
  }, [src, enabled, provider, scope, key])
  if (!enabled || !src) return undefined
  const tone =
    result?.src === src &&
    result.provider === provider &&
    result.scope === scope
      ? result.tone
      : artworkToneSampler.peek(key)
  if (!tone) return undefined
  return {
    "--artwork-primary": tone.primary,
    "--artwork-primary-rgb": tone.primaryRgb,
    "--artwork-ink": tone.ink,
    "--artwork-secondary": tone.secondary,
    "--artwork-secondary-rgb": tone.secondaryRgb,
  } as CSSProperties
}
