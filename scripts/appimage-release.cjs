const fs = require("node:fs/promises")
const { createReadStream } = require("node:fs")
const { createHash } = require("node:crypto")
const path = require("node:path")
const { assetResponse } = require("./check-release.cjs")
const MAX_IMAGE = 512 * 1024 * 1024
const MAX_ZSYNC = 16 * 1024 * 1024
function names(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw Error("Invalid AppImage release tag")
  const image = `Hibiki_${tag.slice(1)}_amd64.AppImage`
  return { image, companion: image + ".zsync" }
}
async function ownedDraft(github, repo, releaseId, tag) {
  const { data } = await github.rest.repos.getRelease({
    ...repo,
    release_id: releaseId,
  })
  if (!data.draft || data.tag_name !== tag)
    throw Error("AppImage companion requires the matching unpublished draft")
  return data
}
async function digest(file, limit) {
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length
    if (bytes > limit) throw Error("AppImage artifact exceeds size limit")
    hash.update(chunk)
  }
  if (!bytes) throw Error("AppImage artifact is empty")
  return { digest: "sha256:" + hash.digest("hex"), size: bytes }
}
async function uploadCompanion(github, repo, releaseId, tag, imagePath) {
  const expected = names(tag)
  if (path.basename(imagePath) !== expected.image)
    throw Error("AppImage filename differs from release tag")
  const release = await ownedDraft(github, repo, releaseId, tag)
  const images = release.assets.filter((asset) => asset.name === expected.image)
  if (images.length !== 1)
    throw Error("Release requires exactly one matching AppImage")
  const image = images[0]
  const actual = await digest(imagePath, MAX_IMAGE)
  if (!image || image.size !== actual.size || image.digest !== actual.digest)
    throw Error("Uploaded AppImage differs from the validated local artifact")
  const companionPath = imagePath + ".zsync"
  const proof = await digest(companionPath, MAX_ZSYNC)
  const companions = release.assets.filter(
    (asset) => asset.name === expected.companion
  )
  if (companions.length > 1)
    throw Error("Release contains duplicate AppImage companions")
  const existing = companions[0]
  if (existing?.digest === proof.digest && existing.size === proof.size)
    return "reused"
  // Never replace assets after publication, even when a job resumes later.
  await ownedDraft(github, repo, releaseId, tag)
  if (existing)
    await github.rest.repos.deleteReleaseAsset({
      ...repo,
      asset_id: existing.id,
    })
  await github.rest.repos.uploadReleaseAsset({
    ...repo,
    release_id: releaseId,
    name: expected.companion,
    data: await fs.readFile(companionPath),
    headers: {
      "content-type": "application/octet-stream",
      "content-length": proof.size,
    },
  })
  return "uploaded"
}
async function downloadUpdateArtifacts(
  github,
  repo,
  releaseId,
  tag,
  directory,
  download = assetResponse
) {
  const expected = names(tag)
  const release = await ownedDraft(github, repo, releaseId, tag)
  await fs.mkdir(directory, { recursive: true })
  for (const [name, limit] of [
    [expected.image, MAX_IMAGE],
    [expected.companion, MAX_ZSYNC],
  ]) {
    const matches = release.assets.filter((asset) => asset.name === name)
    if (
      matches.length !== 1 ||
      !(matches[0].size > 0) ||
      matches[0].size > limit
    )
      throw Error("Release is missing a bounded AppImage update artifact")
    const asset = matches[0],
      file = path.join(directory, name)
    const response = await download(repo, asset)
    if (!response.ok || !response.body)
      throw Error("Could not download AppImage update artifact")
    const output = await fs.open(file, "wx")
    const hash = createHash("sha256")
    let bytes = 0
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength
        if (bytes > limit || bytes > asset.size)
          throw Error("AppImage update artifact exceeds declared size")
        hash.update(chunk)
        await output.writeFile(chunk)
      }
      if (
        bytes !== asset.size ||
        asset.digest !== "sha256:" + hash.digest("hex")
      )
        throw Error(
          "Downloaded AppImage update artifact digest differs from release metadata"
        )
    } finally {
      await output.close()
    }
  }
  return path.join(directory, expected.image)
}
module.exports = { uploadCompanion, downloadUpdateArtifacts }
