/// <reference lib="webworker" />
import {
  pipeline,
  env,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers"
const glueUrl = new URL(
  "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs",
  import.meta.url
).href
let extractor: FeatureExtractionPipeline | null = null
let busy = false
self.onmessage = async ({ data }) => {
  if (busy) {
    self.postMessage({ id: data.id, error: "Local semantic worker is busy" })
    return
  }
  busy = true
  try {
    if (data.type === "initialize") {
      const assets = new Map<string, ArrayBuffer>(
        data.assets.map((asset: { name: string; bytes: ArrayBuffer }) => [
          asset.name,
          asset.bytes,
        ])
      )
      const runtime = assets.get("runtime.wasm")
      if (!runtime) throw new Error("Local semantic runtime is missing")
      globalThis.fetch = (() => {
        throw new Error("Local semantic inference cannot request remote data")
      }) as typeof fetch
      env.allowRemoteModels = false
      env.allowLocalModels = true
      env.localModelPath = "/hibiki-semantic/"
      env.useBrowserCache = false
      env.useCustomCache = true
      env.customCache = {
        match: async (request: RequestInfo | URL) => {
          const url =
            typeof request === "string"
              ? request
              : request instanceof URL
                ? request.href
                : request.url
          const path = new URL(url, self.location.href).pathname.replace(
            /^\/hibiki-semantic\/minilm\//,
            ""
          )
          const value = assets.get(path)
          if (value && path === "tokenizer_config.json") {
            const config = JSON.parse(new TextDecoder().decode(value))
            config.model_max_length = 256
            return new Response(JSON.stringify(config))
          }
          return value ? new Response(value) : undefined
        },
        put: async () => {
          throw new Error("Inference cannot write model assets")
        },
      }
      env.backends.onnx.wasm.numThreads = 1
      env.backends.onnx.wasm.proxy = false
      env.backends.onnx.wasm.wasmPaths = { mjs: glueUrl }
      env.backends.onnx.wasm.wasmBinary = runtime
      extractor = await pipeline("feature-extraction", "minilm", {
        local_files_only: true,
        dtype: "q8",
        device: "wasm",
      })
      if (extractor.tokenizer.model_max_length !== 256)
        throw new Error("Local tokenizer work bound was not applied")
      self.postMessage({ id: data.id, result: true })
    } else if (data.type === "embed") {
      if (!extractor) throw new Error("Local semantic model is not loaded")
      if (
        !Array.isArray(data.texts) ||
        data.texts.length < 1 ||
        data.texts.length > 32 ||
        data.texts.some(
          (text: unknown) => typeof text !== "string" || text.length > 12000
        )
      )
        throw new Error("Invalid local semantic batch")
      const result = await extractor(data.texts, {
        pooling: "mean",
        normalize: true,
      })
      self.postMessage({
        id: data.id,
        result: (result as { tolist(): number[][] }).tolist(),
      })
    } else throw new Error("Unknown local semantic worker request")
  } catch {
    self.postMessage({
      id: data.id,
      error:
        "Local semantic inference failed. Check the downloaded model and try again.",
    })
  } finally {
    busy = false
  }
}
