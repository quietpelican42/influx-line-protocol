import { Decoder, NEED_MORE, precisionNanos } from './decoder.ts';
import { DecodeError } from './errors.ts';
import { stringToUtf8 } from './utf8.ts';
import type { DecodeOptions, Entry, Point } from './types.ts';

type Input = string | ArrayBufferView | ArrayBuffer;

function toBytes(input: Input): Uint8Array {
  if (typeof input === 'string') return stringToUtf8(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function resolve(options: DecodeOptions): { precision: bigint; defaultTime: bigint | null } {
  const precision = precisionNanos(options.precision ?? 'ns');
  const d = options.defaultTime;
  const defaultTime = d === undefined ? null : d instanceof Date ? BigInt(d.getTime()) * 1000000n : d;
  return { precision, defaultTime };
}

function readEntry(dec: Decoder, precision: bigint, defaultTime: bigint | null): Entry {
  try {
    return { ok: true, point: dec.readPoint(precision, defaultTime) };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, error: e };
    throw e;
  }
}

/**
 * Decodes every entry in the input. A bad line does not stop decoding: it is
 * reported as an `{ ok: false, error }` entry and decoding resumes on the next
 * line, as the Go decoder does. Input strings are UTF-8 encoded; pass bytes to
 * decode input that may contain invalid UTF-8 (which is then rejected).
 */
export function* decodeEntries(input: Input, options: DecodeOptions = {}): Generator<Entry, void, undefined> {
  const { precision, defaultTime } = resolve(options);
  const dec = new Decoder(toBytes(input), true);
  while (dec.next()) yield readEntry(dec, precision, defaultTime);
}

/** Decodes every point, throwing the `DecodeError` of the first bad line. */
export function* decode(input: Input, options: DecodeOptions = {}): Generator<Point, void, undefined> {
  for (const entry of decodeEntries(input, options)) {
    if (!entry.ok) throw entry.error;
    yield entry.point;
  }
}

/** Decodes all points into an array, throwing the `DecodeError` of the first bad line. */
export function parse(input: Input, options: DecodeOptions = {}): Point[] {
  return [...decode(input, options)];
}

type Chunk = string | ArrayBufferView | ArrayBuffer;

/**
 * Decodes chunked input (a Node stream, a web stream, or any async or sync
 * iterable of strings or bytes) without buffering more than the current entry.
 * Entries may span chunk boundaries. Bad lines are reported as error entries.
 */
export async function* decodeStreamEntries(
  source: AsyncIterable<Chunk> | Iterable<Chunk>,
  options: DecodeOptions = {},
): AsyncGenerator<Entry, void, undefined> {
  const { precision, defaultTime } = resolve(options);
  const dec = new Decoder(new Uint8Array(0), false);
  let carry = ''; // a trailing high surrogate waiting for its pair
  const drain = function* (): Generator<Entry, void, undefined> {
    for (;;) {
      const snap = dec.snapshot();
      let entry: Entry;
      try {
        if (!dec.next()) return;
        entry = readEntry(dec, precision, defaultTime);
      } catch (e) {
        if (e === NEED_MORE) {
          dec.restore(snap);
          return;
        }
        throw e;
      }
      yield entry;
    }
  };
  for await (const chunk of source) {
    let bytes: Uint8Array;
    if (typeof chunk === 'string') {
      let s = carry + chunk;
      carry = '';
      const last = s.charCodeAt(s.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        carry = s.slice(-1);
        s = s.slice(0, -1);
      }
      bytes = stringToUtf8(s);
    } else {
      bytes = toBytes(chunk);
    }
    if (bytes.length === 0) continue;
    dec.refill(bytes);
    yield* drain();
  }
  if (carry) dec.refill(stringToUtf8(carry));
  dec.complete = true;
  yield* drain();
}

/** Like `decodeStreamEntries`, but throws the `DecodeError` of the first bad line. */
export async function* decodeStream(
  source: AsyncIterable<Chunk> | Iterable<Chunk>,
  options: DecodeOptions = {},
): AsyncGenerator<Point, void, undefined> {
  for await (const entry of decodeStreamEntries(source, options)) {
    if (!entry.ok) throw entry.error;
    yield entry.point;
  }
}
