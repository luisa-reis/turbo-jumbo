/**
 * The receiving half of a `send` job: append one chunk of a file at a stated
 * offset. This is a weight write, which the interface's small-file cap keeps
 * out of `write` on purpose — so it lives beside the storage implementation,
 * on an absolute path the agent handler has already confined, rather than on
 * the interface.
 */

import {createWriteStream, promises as fsp} from 'fs';
import nodePath from 'path';
import {Readable} from 'stream';
import {pipeline} from 'stream/promises';

export type ReceiveOutcome =
  | {ok: true}
  /** The offset doesn't name exactly the bytes already here. */
  | {ok: false; heldBytes: number | null};

/**
 * Write `body` into `fullPath` at `offset`, creating parent directories.
 *
 * A non-zero offset appends, so it has to name exactly the end of what is
 * already here. Senders resume from a prefix they verified moments earlier;
 * if the file changed since, appending would splice bytes into the wrong
 * place and leave a plausible-looking corrupt file. Refuse instead, and let
 * the sender start over. Offset 0 truncates whatever partial mismatch is
 * there; later chunks append (`a` — O_APPEND seeks to EOF atomically, correct
 * for sequential chunks).
 */
export async function receiveChunk(
  fullPath: string,
  offset: number,
  body: ReadableStream<Uint8Array> | null,
): Promise<ReceiveOutcome> {
  await fsp.mkdir(nodePath.dirname(fullPath), {recursive: true});

  if (offset > 0) {
    let heldBytes: number | null;
    try {
      heldBytes = (await fsp.stat(fullPath)).size;
    } catch {
      heldBytes = null;
    }
    if (heldBytes !== offset) return {ok: false, heldBytes};
  }

  if (!body) {
    // Empty file or missing body — create/truncate when this is the first chunk.
    if (offset === 0) await fsp.writeFile(fullPath, new Uint8Array(0));
    return {ok: true};
  }

  const writer = createWriteStream(
    fullPath,
    offset === 0 ? undefined : {flags: 'a'},
  );
  // @ts-expect-error – DOM ReadableStream vs Node ReadableStream type mismatch
  await pipeline(Readable.fromWeb(body), writer);
  return {ok: true};
}
