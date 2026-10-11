export interface ShutdownWork {
  stopAndRetain(): Promise<void>
  flushPreferences(): Promise<void>
  flushRemote(): Promise<{ pending: number }>
}

/** Local retention is mandatory; bounded remote flush can leave durable work. */
export class GracefulShutdown {
  private active: Promise<{ pending: number }> | null = null
  constructor(private work: ShutdownWork, private deadlineMs = 8000) {}
  prepare(): Promise<{ pending: number }> {
    if (this.active) return this.active
    const work = (async () => {
      await this.work.stopAndRetain()
      await this.work.flushPreferences()
      return this.work.flushRemote()
    })()
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Closing took too long. Your window stayed open; retry saving before quitting.")), this.deadlineMs)
    })
    const attempt = Promise.race([work, deadline]).finally(() => {
      clearTimeout(timer)
      if (this.active === attempt) this.active = null
    })
    this.active = attempt
    return attempt
  }
}

/** Download first; freeze/retain immediately before an installer may exit. */
export async function runPreparedUpdate(work: {
  download(): Promise<void>
  prepareExit(): Promise<void>
  install(): Promise<void>
  resume(): Promise<void>
}): Promise<void> {
  try {
    await work.download()
    await work.prepareExit()
    await work.install()
  } catch (error) {
    await work.resume()
    throw error
  }
  // Windows exits from install; macOS/Linux retain the current application.
  await work.resume()
}
