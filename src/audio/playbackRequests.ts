/** Keep asynchronous metadata/gain lookups from committing an obsolete selection. */
export async function dispatchPlaybackWhenReady<T>(
  prepare: () => Promise<T>,
  isCurrent: () => boolean,
  send: (value: T) => Promise<void>,
): Promise<boolean> {
  const value = await prepare()
  if (!isCurrent()) return false
  await send(value)
  return isCurrent()
}
