/** Explain known native failures without displaying remote text or credential-bearing URLs. */
export function radioDirectoryErrorHint(error: unknown): string {
  const message = (
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : ""
  ).toLowerCase()
  if (
    message.includes("command") &&
    (message.includes("not found") || message.includes("unknown command"))
  )
    return "This desktop build is missing a radio command. Restart Hibiki with the current build."
  if (message.includes("invalid args") || message.includes("invalid argument"))
    return "The desktop app rejected the radio request. Update or restart Hibiki and try again."
  if (
    message.includes("reading 'invoke'") ||
    message.includes('reading "invoke"')
  )
    return "The radio directory needs the Hibiki desktop app."
  if (message.includes("certificate") || message.includes("tls"))
    return "A secure connection to the radio directory could not be established."
  if (message.includes("429") || message.includes("too many requests"))
    return "The radio directory is busy. Wait a moment before trying again."
  if (message.includes("timed out") || message.includes("timeout"))
    return "The radio directory did not respond in time. Try again in a moment."
  if (message.includes("parse") || message.includes("deserialize"))
    return "The radio directory returned data that could not be read."
  return "Check your connection and try again."
}
