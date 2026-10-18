/** Release callers and coalescing slots even if an IPC/provider promise never settles. */
export async function withTimeout<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
