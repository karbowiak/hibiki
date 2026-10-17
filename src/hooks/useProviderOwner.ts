import { useShallow } from "zustand/react/shallow"
import { useProviderStore } from "../stores/providerStore"

/** Snapshot mutable provider identity so reconnects also update hook consumers. */
export const useProviderOwner = () =>
  useProviderStore(
    useShallow((state) => ({
      provider: state.provider,
      session: state.provider?.playbackSession,
      scope: state.provider?.cacheScope,
    }))
  )
