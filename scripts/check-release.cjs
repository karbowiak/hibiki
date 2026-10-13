const { createHash, createPublicKey, verify } = require("node:crypto")

function fail(message) {
  throw new Error(message)
}

async function assertCI(github, repo, tag, commit) {
  const tagged = await github.rest.repos.getCommit({
    ...repo,
    ref: `refs/tags/${tag}`,
  })
  if (tagged.data.sha !== commit)
    fail(
      `Tag ${tag} changed after checkout; refusing to release another commit.`
    )
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo,
    workflow_id: "ci.yml",
    head_sha: commit,
    per_page: 100,
  })
  // A PR check (including a fork) cannot stand in for main's complete push CI.
  // Never select an older success over a newer pending/failed/canceled run.
  const current = runs
    .filter(
      (run) =>
        run.head_sha === commit &&
        run.event === "push" &&
        run.head_branch === "main" &&
        run.head_repository?.full_name === `${repo.owner}/${repo.repo}`
    )
    .sort((a, b) => b.id - a.id)[0]
  if (
    !current ||
    current.status !== "completed" ||
    current.conclusion !== "success"
  ) {
    fail(
      `CI for exact tagged commit ${commit} has not passed on main. Wait for CI and retry this release workflow with ${tag}.`
    )
  }
}

function base64(value, label) {
  if (typeof value !== "string") fail(`Missing ${label}`)
  const encoded = value.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail(`Invalid ${label} encoding`)
  const bytes = Buffer.from(encoded, "base64")
  if (
    bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  )
    fail(`Invalid ${label} encoding`)
  return bytes
}

function publicKey(encoded) {
  const lines = base64(encoded, "updater public key")
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
  const packet = base64(lines[1], "updater public key packet")
  if (
    packet.length !== 42 ||
    !["Ed", "ED"].includes(packet.subarray(0, 2).toString())
  )
    fail("Invalid updater public key")
  return {
    id: packet.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        packet.subarray(10),
      ]),
      format: "der",
      type: "spki",
    }),
  }
}

function signedVersionRequired(tag) {
  const [major, minor] = tag.slice(1).split(".").map(Number)
  return major > 0 || minor >= 6
}

function signature(encoded, key, expected) {
  const lines = base64(encoded, "updater signature")
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment: ") ||
    !lines[2].startsWith("trusted comment: ")
  )
    fail("Invalid minisign signature document")
  const packet = base64(lines[1], "minisign signature packet")
  const global = base64(lines[3], "minisign comment signature")
  // This matches minisign-verify's updater mode: legacy unhashed Ed signatures
  // are refused. ED signs the BLAKE2b-512 digest of the complete artifact.
  if (
    packet.length !== 74 ||
    packet.subarray(0, 2).toString() !== "ED" ||
    global.length !== 64
  )
    fail("Invalid prehashed minisign signature")
  if (!packet.subarray(2, 10).equals(key.id))
    fail("Updater signature belongs to another signing key")
  const signed = packet.subarray(10)
  const comment = Buffer.from(
    lines[2].slice("trusted comment: ".length),
    "utf8"
  )
  if (!verify(null, Buffer.concat([signed, comment]), key.key, global))
    fail("Invalid minisign trusted-comment signature")
  if (expected) {
    const fields = new Map()
    for (const field of comment.toString("utf8").split("\t")) {
      const colon = field.indexOf(":")
      if (colon < 1 || fields.has(field.slice(0, colon)))
        fail("Invalid signed release comment fields")
      fields.set(field.slice(0, colon), field.slice(colon + 1))
    }
    if (
      fields.size !== 3 ||
      !/^\d+$/.test(fields.get("timestamp") ?? "") ||
      !fields.get("file") ||
      !fields.get("version")
    )
      fail("Invalid signed release comment fields")
    if (fields.get("version") !== expected.version)
      fail("Signed artifact version differs from release tag")
    if (expected.file && fields.get("file") !== expected.file)
      fail("Signed artifact filename differs from release asset")
  }
  return signed
}

function artifactPlan(manifest, release, repo, tag) {
  const version = tag.slice(1)
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || manifest.version !== version)
    fail(`Updater manifest version must be ${version}`)
  if (release.tag_name !== tag || !release.draft)
    fail("Artifact checks require the matching draft release")
  const assets = new Map()
  const assetsById = new Map()
  for (const asset of release.assets) {
    if (assets.has(asset.name)) fail(`Duplicate release asset ${asset.name}`)
    if (
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      assetsById.has(asset.id)
    )
      fail(`Invalid or duplicate release asset ID for ${asset.name}`)
    assets.set(asset.name, asset)
    assetsById.set(asset.id, asset)
  }
  const required = (name) => {
    const asset = assets.get(name)
    if (
      !asset ||
      asset.state !== "uploaded" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    )
      fail(`Missing or incomplete release asset ${name}`)
    return asset
  }
  required("latest.json")
  required(`Hibiki_${version}_aarch64.dmg`)
  required(`Hibiki_${version}_x64.dmg`)
  const expected = {
    "darwin-aarch64-app": `Hibiki_${version}_aarch64.app.tar.gz`,
    "darwin-x86_64-app": `Hibiki_${version}_x64.app.tar.gz`,
    "linux-x86_64-appimage": `Hibiki_${version}_amd64.AppImage`,
    "linux-x86_64-deb": `Hibiki_${version}_amd64.deb`,
    "linux-x86_64-rpm": `Hibiki-${version}-1.x86_64.rpm`,
    "windows-x86_64-msi": `Hibiki_${version}_x64_en-US.msi`,
    "windows-x86_64-nsis": `Hibiki_${version}_x64-setup.exe`,
  }
  const aliases = {
    "darwin-aarch64": ["darwin-aarch64-app"],
    "darwin-x86_64": ["darwin-x86_64-app"],
    "linux-x86_64": ["linux-x86_64-appimage"],
    "windows-x86_64": ["windows-x86_64-msi", "windows-x86_64-nsis"],
  }
  const platforms = manifest.platforms
  if (!platforms || typeof platforms !== "object")
    fail("Updater manifest has no platforms")
  for (const platform of [...Object.keys(expected), ...Object.keys(aliases)]) {
    if (!platforms[platform]) fail(`Updater manifest is missing ${platform}`)
  }
  const plan = new Map()
  for (const [platform, entry] of Object.entries(platforms)) {
    if (!expected[platform] && !aliases[platform])
      fail(`Unexpected updater platform ${platform}`)
    if (
      !entry ||
      typeof entry.url !== "string" ||
      typeof entry.signature !== "string" ||
      !entry.signature.trim()
    )
      fail(`Incomplete updater entry ${platform}`)
    const url = new URL(entry.url)
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail(`Updater URL for ${platform} must refer to this release`)
    const prefix = `/${repo.owner}/${repo.repo}/releases/download/${tag}/`
    let name
    if (url.hostname === "github.com" && url.pathname.startsWith(prefix)) {
      name = decodeURIComponent(url.pathname.slice(prefix.length))
    } else if (url.hostname === "api.github.com") {
      // Tauri action v1 emits GitHub API URLs. The immutable asset ID must
      // belong to this exact tag's release; checking the host alone is unsafe.
      const apiPrefix = `/repos/${repo.owner}/${repo.repo}/releases/assets/`
      const id = url.pathname.startsWith(apiPrefix)
        ? url.pathname.slice(apiPrefix.length)
        : ""
      if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))
        fail(`Updater URL for ${platform} must refer to this release`)
      name = assetsById.get(Number(id))?.name
      if (!name)
        fail(`Updater asset for ${platform} does not belong to this release`)
    } else {
      fail(`Updater URL for ${platform} must refer to this release`)
    }
    // v0.5.1 used Tauri's historical unversioned macOS updater archives.
    // Current tauri-action v1 uploads versioned names; never accept another
    // release version's archive or a legacy name for a new release.
    const legacy =
      version === "0.5.1" &&
      {
        "darwin-aarch64-app": "Hibiki_aarch64.app.tar.gz",
        "darwin-x86_64-app": "Hibiki_x64.app.tar.gz",
      }[platform]
    if (expected[platform] && name !== expected[platform] && name !== legacy)
      fail(`Wrong artifact for ${platform}`)
    if (
      aliases[platform] &&
      !aliases[platform].some(
        (target) =>
          platforms[target].url === entry.url &&
          platforms[target].signature === entry.signature
      )
    )
      fail(`Updater alias ${platform} disagrees with its installer`)
    const artifact = required(name)
    const companion = required(`${name}.sig`)
    if (plan.has(name) && plan.get(name).encoded !== entry.signature)
      fail(`Conflicting signatures for ${name}`)
    plan.set(name, { artifact, companion, encoded: entry.signature })
  }
  if (signedVersionRequired(tag)) {
    for (const arch of ["aarch64", "x64"]) {
      const name = `Hibiki_${version}_${arch}.dmg`
      const artifact = required(name)
      if (artifact.size < 512)
        fail(`DMG is too small to contain a UDIF trailer: ${name}`)
      plan.set(name, {
        artifact,
        companion: required(`${name}.sig`),
        dmg: true,
      })
    }
  }
  return [...plan.values()]
}

async function assetResponse(
  repo,
  asset,
  fetchImpl = fetch,
  token = process.env.GITHUB_TOKEN
) {
  let url = new URL(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/assets/${asset.id}`
  )
  for (let redirects = 0; redirects < 5; redirects++) {
    const headers = { Accept: "application/octet-stream" }
    if (url.hostname === "api.github.com" && token)
      headers.Authorization = `Bearer ${token}`
    const response = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get("Location"), url)
      await response.body?.cancel()
      if (
        next.protocol !== "https:" ||
        ![
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
        ].includes(next.hostname)
      )
        fail("Unexpected release-asset redirect")
      url = next
      continue
    }
    if (!response.ok || !response.body)
      fail(`Cannot download release asset ${asset.name}`)
    return response
  }
  fail(`Too many redirects downloading ${asset.name}`)
}

async function consume(response, asset, maxBytes, onChunk) {
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes || size > asset.size)
      fail(`Release asset ${asset.name} exceeds expected size`)
    onChunk(Buffer.from(chunk))
  }
  if (size !== asset.size) fail(`Release asset ${asset.name} is truncated`)
}

async function readSmall(repo, asset, maxBytes, download) {
  const chunks = []
  await consume(await download(repo, asset), asset, maxBytes, (chunk) =>
    chunks.push(chunk)
  )
  return Buffer.concat(chunks).toString("utf8")
}

async function assertArtifacts(
  github,
  repo,
  tag,
  releaseId,
  encodedKey,
  download = assetResponse
) {
  const { data: release } = await github.rest.repos.getRelease({
    ...repo,
    release_id: releaseId,
  })
  const metadata = release.assets.find((asset) => asset.name === "latest.json")
  if (!metadata) fail("Release has no latest.json updater manifest")
  const manifest = JSON.parse(
    await readSmall(repo, metadata, 1024 * 1024, download)
  )
  const plan = artifactPlan(manifest, release, repo, tag)
  const key = publicKey(encodedKey)
  // Fetch each unique installer once and stream its digest. No release-sized
  // buffer is retained; aliases share verification of the same artifact.
  for (const { artifact, companion, encoded, dmg } of plan) {
    const uploaded = await readSmall(repo, companion, 16 * 1024, download)
    const signed = signature(
      encoded ?? uploaded.trim(),
      key,
      signedVersionRequired(tag)
        ? { version: tag.slice(1), ...(dmg ? { file: artifact.name } : {}) }
        : undefined
    )
    if (encoded && uploaded.trim() !== encoded.trim())
      fail(`Manifest signature differs from ${companion.name}`)
    const hash = createHash("blake2b512")
    await consume(
      await download(repo, artifact),
      artifact,
      512 * 1024 * 1024,
      (chunk) => hash.update(chunk)
    )
    if (!verify(null, hash.digest(), key.key, signed))
      fail(`Invalid updater signature for ${artifact.name}`)
  }
  return plan.length
}

module.exports = {
  assertCI,
  artifactPlan,
  publicKey,
  signature,
  assetResponse,
  assertArtifacts,
}
