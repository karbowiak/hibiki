import { invoke } from "@tauri-apps/api/core"
import type { PlexRequestContext } from "../backends/plex/scopedApi"
import type {
  SemanticDocument,
  SemanticEmbedding,
  SemanticMatch,
} from "./types"
import { SEMANTIC_MODEL_ID } from "./manifest"
export function createSemanticApi(context: PlexRequestContext) {
  const owned = Object.freeze({ ...context })
  return {
    documents: () =>
      invoke<SemanticDocument[]>("semantic_documents", { context: owned }),
    put: (embeddings: SemanticEmbedding[]) =>
      invoke<void>("semantic_put_vectors", {
        context: owned,
        modelId: SEMANTIC_MODEL_ID,
        embeddings,
      }),
    search: (queryVector: number[], limit = 20) =>
      invoke<SemanticMatch[]>("semantic_search", {
        context: owned,
        modelId: SEMANTIC_MODEL_ID,
        queryVector,
        limit,
      }),
    info: () =>
      invoke<{ indexed: number; modelId: string }>("semantic_info", {
        context: owned,
      }),
    clear: () => invoke<void>("semantic_clear", { context: owned }),
  }
}
