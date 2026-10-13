import { runLivePlaylistSmoke } from "./runner"
const input = JSON.parse(await Bun.stdin.text())
const origin = new URL(input.origin)
if (
  origin.protocol !== "http:" ||
  origin.hostname !== "127.0.0.1" ||
  typeof input.access !== "string" ||
  input.access.length !== 36
)
  throw Error("Invalid local QA bridge")
try {
  const result = await runLivePlaylistSmoke({
    request: async <T>(action: string, payload?: unknown): Promise<T> => {
      const response = await fetch(new URL("/qa", origin), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.access}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action, payload }),
      })
      if (!response.ok)
        throw Error(
          "Native QA refused or did not confirm the operation; stop and inspect private manifest"
        )
      return (await response.json()) as T
    },
  })
  console.log(JSON.stringify(result))
} catch {
  console.error(
    "Live QA stopped without further writes. Inspect the private manifest; do not rerun creates."
  )
  process.exitCode = 1
}
