/**
 * Run `worker` over every item, at most `limit` at a time.
 *
 * Workers share one queue rather than marching through fixed batches: each
 * takes the next item the moment its last one finishes, so a single slow item
 * never holds back the rest. Order of *starting* follows the array; order of
 * finishing does not.
 *
 * Rejects with the first error a worker throws. The other workers are not
 * cancelled — nothing here can stop work already in flight — so a caller that
 * needs them to wind down should share an `AbortSignal` with its worker and
 * let that be the stop signal, and a caller that wants failures collected
 * rather than fatal should catch inside its worker.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  // One shared cursor, handed out by the workers themselves. `next++` is
  // atomic here the way it is anywhere in JS: nothing else runs between the
  // read and the write, so no two workers can take the same index.
  let next = 0;
  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(
    Array.from({length: lanes}, async () => {
      for (let i = next++; i < items.length; i = next++) {
        await worker(items[i], i);
      }
    }),
  );
}
