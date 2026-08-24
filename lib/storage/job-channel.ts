/**
 * The channel between a job and its one consumer: the job pushes events, the
 * consumer pulls them as an async iterable, and a terminal event closes it.
 * Shared by the local jobs (which produce events in-process) and the HTTP
 * storage (which replays an agent's NDJSON stream through the same shape).
 */

import type {JobEvent, JobHandle} from '@/lib/storage/storage';

/** Events pushed by the job, pulled by one consumer. Closes itself on a
 *  terminal event; anything pushed after is dropped. */
export class JobChannel implements AsyncIterable<JobEvent> {
  private queue: JobEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: JobEvent): void {
    if (this.closed) return;
    this.queue.push(event);
    if (event.kind === 'done' || event.kind === 'error') this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JobEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/** A `JobHandle` over a channel and a way to stop the work behind it. */
export function jobHandle(
  channel: JobChannel,
  cancel: () => Promise<void> | void,
): JobHandle {
  return {
    id: crypto.randomUUID(),
    events: () => channel,
    cancel: async () => {
      await cancel();
    },
  };
}
