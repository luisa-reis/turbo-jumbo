import {sha256Region} from '@/lib/storage/file-transfer';

/**
 * How the far side is asked about its copy of a file. Split in two because
 * the size is free (one inventory entry) while the digest costs a full read
 * of what it holds: knowing the size first lets the source hash its own
 * matching prefix at the same time the far side hashes its copy, instead of
 * after. The caller supplies the reader — the send job backs it with the
 * target agent's `list` and `hash` verbs.
 */
export interface PeerFileReader {
  /** Bytes the peer currently holds, or null if it holds the file at all. */
  size: (peer: string, file: string) => Promise<number | null>;
  /** SHA256 over exactly those bytes, or null if the peer can't say. */
  sha256: (peer: string, file: string) => Promise<string | null>;
}

/**
 * Where an upload of `srcFull` to `file` on `peer` may resume.
 *
 * An upload to a peer has always restarted at byte zero, because the sender
 * cannot stat the receiver's disk — so a transfer of a 4 GiB shard cut off
 * near the end cost the whole 4 GiB again rather than the tail it was missing.
 * The receiver can speak for itself, though: it reports how many bytes it
 * holds and the SHA256 over exactly those bytes, and when the source's own
 * first `size` bytes hash to the same value the partial is a verified prefix
 * of the file being sent — so only the rest has to travel.
 *
 * Returns that byte count, or 0 meaning send the whole file: the destination
 * is absent, empty, longer than the source (so not a prefix of it), holds
 * different bytes, or is a peer too old to answer with a SHA256. A return
 * equal to the source's size means the destination is already complete and
 * identical and nothing need be sent at all.
 *
 * `onVerify` reports the source-side hash as (hashed, total) byte counts. It
 * covers this side only — the peer hashes its copy concurrently and out of
 * sight — and is called only when a partial is actually verified, so a caller
 * can use it to tell "nothing to resume from" apart from "prefix compared".
 */
export async function peerResumeOffset(opts: {
  peer: string;
  file: string;
  srcFull: string;
  srcSize: number;
  signal?: AbortSignal;
  onVerify?: (hashedBytes: number, totalBytes: number) => void;
  reader: PeerFileReader;
}): Promise<number> {
  const {peer, file, srcFull, srcSize, signal, onVerify, reader} = opts;

  const destSize = await reader.size(peer, file);
  // Nothing there, nothing held, or more bytes than we are sending — in which
  // case it isn't a prefix of this file and the whole thing goes.
  if (destSize === null || destSize <= 0 || destSize > srcSize) return 0;

  let hashed = 0;
  const onBytes =
    onVerify &&
    ((n: number) => {
      hashed += n;
      onVerify(hashed, destSize);
    });

  let destSha: string | null;
  let srcSha: string;
  try {
    [destSha, srcSha] = await Promise.all([
      reader.sha256(peer, file),
      sha256Region(srcFull, destSize, {signal, onBytes}),
    ]);
  } catch {
    return 0; // unreadable source, or the caller gave up mid-hash
  }
  return destSha !== null && destSha === srcSha ? destSize : 0;
}
