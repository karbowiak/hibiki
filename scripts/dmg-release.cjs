const fs = require("node:fs/promises")
const path = require("node:path")
const { createHash } = require("node:crypto")
const { createReadStream } = require("node:fs")
async function uploadDmgSignature(github, repo, releaseId, tag, file) {
  if (
    !/^v\d+\.\d+\.\d+$/.test(tag) ||
    !new RegExp(
      `^Hibiki_${tag.slice(1).replaceAll(".", "\\.")}_(aarch64|x64)\\.dmg$`
    ).test(path.basename(file))
  )
    throw Error("DMG name differs from release tag")
  async function draft() {
    const { data } = await github.rest.repos.getRelease({
      ...repo,
      release_id: releaseId,
    })
    if (!data.draft || data.tag_name !== tag)
      throw Error("DMG signing requires the matching unpublished draft")
    return data
  }
  const release = await draft()
  const images = release.assets.filter(
    (asset) => asset.name === path.basename(file)
  )
  if (images.length !== 1)
    throw Error("Release requires exactly one matching DMG")
  let size = 0
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) {
    size += chunk.length
    if (size > 512 * 1024 * 1024)
      throw Error("DMG exceeds installer size limit")
    hash.update(chunk)
  }
  if (
    size < 512 ||
    images[0].size !== size ||
    images[0].digest !== `sha256:${hash.digest("hex")}`
  )
    throw Error("Uploaded DMG differs from the verified local image")
  const sidecarSize = (await fs.stat(file + ".sig")).size
  if (!sidecarSize || sidecarSize > 16 * 1024)
    throw Error("Invalid DMG signature size")
  const bytes = await fs.readFile(file + ".sig")
  if (!bytes.length || bytes.length > 16 * 1024)
    throw Error("Invalid DMG signature size")
  const name = path.basename(file) + ".sig",
    digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  const existing = release.assets.filter((asset) => asset.name === name)
  if (existing.length > 1) throw Error("Duplicate DMG signature assets")
  if (existing[0]?.digest === digest && existing[0].size === bytes.length)
    return "reused"
  await draft()
  if (existing[0])
    await github.rest.repos.deleteReleaseAsset({
      ...repo,
      asset_id: existing[0].id,
    })
  await github.rest.repos.uploadReleaseAsset({
    ...repo,
    release_id: releaseId,
    name,
    data: bytes,
    headers: { "content-type": "text/plain", "content-length": bytes.length },
  })
  return "uploaded"
}
module.exports = { uploadDmgSignature }
