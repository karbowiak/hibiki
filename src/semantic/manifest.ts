export const SEMANTIC_MODEL_ID =
  "minilm-l6-v2-q8@751bff37182d3f1213fa05d7196b954e230abad9"
export const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9"
const modelBase = `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${MODEL_REVISION}/`
export const SEMANTIC_ASSETS = [
  {
    name: "config.json",
    bytes: 650,
    sha256: "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
    url: modelBase + "config.json",
  },
  {
    name: "tokenizer_config.json",
    bytes: 366,
    sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
    url: modelBase + "tokenizer_config.json",
  },
  {
    name: "tokenizer.json",
    bytes: 711661,
    sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    url: modelBase + "tokenizer.json",
  },
  {
    name: "onnx/model_quantized.onnx",
    bytes: 22972370,
    sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
    url: modelBase + "onnx/model_quantized.onnx",
  },
  {
    name: "runtime.wasm",
    bytes: 26861777,
    sha256: "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082",
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.asyncify.wasm",
  },
] as const
export const SEMANTIC_DOWNLOAD_BYTES = SEMANTIC_ASSETS.reduce(
  (sum, asset) => sum + asset.bytes,
  0
)
export type SemanticAsset = (typeof SEMANTIC_ASSETS)[number]
