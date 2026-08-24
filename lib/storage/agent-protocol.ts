/**
 * The wire between `HttpStorage` and an agent — or the full app serving as
 * one, at `/api/v1/storage/[op]`. Every operation is a POST to `<base>/<op>`:
 *
 * - `list`, `mkdir`, `remove`, `move`, `copy`, `link`, `usage`: a JSON body
 *   (the verb's arguments, refs as `{root, path}`), a JSON reply.
 * - `read`: a JSON ref; the reply is the raw bytes.
 * - `write`: raw bytes as the body with the ref in the headers below — a
 *   JSON wrapping would base64 every sidecar for nothing.
 * - `hash`: a JSON ref; the reply streams `HashFrame` NDJSON — cumulative
 *   byte counts while hashing, then the digest, or the failure.
 * - `job`: a `JobSpec`; the reply streams its `JobEvent`s as NDJSON, ending
 *   with the terminal event. Cancelling is closing the connection: jobs are
 *   connection-scoped over the wire just as they are in-process, where the
 *   handle that started one is the only thing that can cancel it.
 *
 * Errors are non-2xx with the message as a text body. Dependency-free on
 * purpose: both sides import shapes from here, neither imports the other.
 */

/** Cumulative bytes hashed so far, then the digest — or the failure. */
export type HashFrame = {bytes: number} | {sha256: string} | {error: string};

/** The `write` ref headers: the root by name, the path URI-encoded (a header
 *  value can't carry every byte a filename can). */
export const REF_ROOT_HEADER = 'x-tj-root';
export const REF_PATH_HEADER = 'x-tj-path';

/** How often the hash stream reports progress — the byte-progress cadence the
 *  transfer routes already emit at. A final frame always closes the count. */
export const HASH_EMIT_BYTES = 8 * 1024 * 1024;
