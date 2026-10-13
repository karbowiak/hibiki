import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  validateAsset,
  installedAssets,
  installAssets,
  type AssetStorage,
} from "../../src/semantic/assets"
import { SEMANTIC_ASSETS, SEMANTIC_MODEL_ID } from "../../src/semantic/manifest"
const config = await readFile(
  new URL("./semanticDiscovery/model-config.json", import.meta.url)
)
const bytes = config.buffer.slice(
  config.byteOffset,
  config.byteOffset + config.byteLength
) as ArrayBuffer
await validateAsset(SEMANTIC_ASSETS[0], bytes)
const corrupt = bytes.slice(0)
new Uint8Array(corrupt)[0] ^= 1
await assert.rejects(validateAsset(SEMANTIC_ASSETS[0], corrupt), /integrity/)
await assert.rejects(
  validateAsset(SEMANTIC_ASSETS[0], new ArrayBuffer(651)),
  /size/
)
let requests = 0
let writes = 0
const saved = new Map<string, unknown>()
const backend: AssetStorage = {
  get: async (key) => saved.get(key),
  put: async (key, value) => {
    writes++
    saved.set(key, value)
  },
}
assert.equal(await installedAssets(backend), null)
assert.equal(requests, 0)
assert.equal(writes, 0)
const previous = new ArrayBuffer(12)
saved.set(`${SEMANTIC_MODEL_ID}:tokenizer_config.json`, previous)
await assert.rejects(
  installAssets(() => {}, backend, (async (url) => {
    requests++
    return new Response(
      url === SEMANTIC_ASSETS[0].url ? bytes : new ArrayBuffer(1000)
    )
  }) as typeof fetch),
  /limit/
)
assert.equal(requests, 2)
assert.equal(writes, 1)
assert.equal(saved.get(`${SEMANTIC_MODEL_ID}:tokenizer_config.json`), previous)
await assert.rejects(installedAssets(backend), /size/)
