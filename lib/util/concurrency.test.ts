import {test, expect} from 'bun:test';
import {runWithConcurrency} from '@/lib/util/concurrency';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('runWithConcurrency runs every item exactly once', async () => {
  const seen: number[] = [];
  await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    await tick();
    seen.push(n);
  });
  expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
});

test('runWithConcurrency never exceeds the limit', async () => {
  let running = 0;
  let peak = 0;
  await runWithConcurrency([...Array(12).keys()], 3, async () => {
    running++;
    peak = Math.max(peak, running);
    await tick(1);
    running--;
  });
  expect(peak).toBe(3);
});

test('runWithConcurrency takes the next item as capacity frees, not in batches', async () => {
  // The first item is slow; a batching implementation would stall every other
  // worker behind it. Sharing one queue, the fast lane should drain the rest.
  const done: number[] = [];
  await runWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => {
    await tick(n === 0 ? 40 : 1);
    done.push(n);
  });
  // The slow first item finishes last despite starting first.
  expect(done[done.length - 1]).toBe(0);
  expect(done.length).toBe(5);
});

test('runWithConcurrency rejects with the first worker error', async () => {
  await expect(
    runWithConcurrency([1, 2, 3], 2, async (n) => {
      await tick();
      if (n === 2) throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
});

test('runWithConcurrency passes each item its index', async () => {
  const pairs: Array<[string, number]> = [];
  await runWithConcurrency(['a', 'b', 'c'], 1, async (item, i) => {
    pairs.push([item, i]);
  });
  expect(pairs).toEqual([
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ]);
});

test('runWithConcurrency handles an empty list and an oversized limit', async () => {
  let calls = 0;
  await runWithConcurrency([], 8, async () => {
    calls++;
  });
  expect(calls).toBe(0);
  await runWithConcurrency([1, 2], 99, async () => {
    calls++;
  });
  expect(calls).toBe(2);
});

test('runWithConcurrency treats a limit below one as serial', async () => {
  let running = 0;
  let peak = 0;
  await runWithConcurrency([1, 2, 3], 0, async () => {
    running++;
    peak = Math.max(peak, running);
    await tick(1);
    running--;
  });
  expect(peak).toBe(1);
});
