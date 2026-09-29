import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The official corpus, pinned to a commit of github.com/influxdata/line-protocol. */
export const CORPUS_COMMIT = '08518c8fca06f307353bc0a0d7c9f96c2cadff93';
export const CORPUS_SHA256 = '81c8e0109de454cf3918e7baf94856a1d75bb1ddfc78d5364da2bff1e7bda6f3';
export const CORPUS_URL = `https://raw.githubusercontent.com/influxdata/line-protocol/${CORPUS_COMMIT}/lineprotocol/testdata/corpus.json`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheFile = join(root, '.cache', `corpus-${CORPUS_COMMIT.slice(0, 12)}.json`);

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** A JSON number kept as its source text, so 64-bit integers survive. */
export class Num {
  readonly src: string;
  constructor(src: string) {
    this.src = src;
  }
}

export interface CorpusPoint {
  time: Num;
  name: string;
  tags: { key: string; value: string }[];
  fields: { key: string; value: Record<string, Num | string | boolean> }[];
}

export interface DecodeCase {
  input: { key: string; text: string | { binary: string }; defaultTime: Num; precision: string; implementation: string };
  output: { error?: string; result?: CorpusPoint[] };
}

export interface EncodeCase {
  input: { key: string; point: CorpusPoint; precision: string };
  output: { error?: string; result?: string };
}

export interface Corpus {
  decode: Record<string, DecodeCase>;
  encode: Record<string, EncodeCase>;
}

/** Returns the corpus, fetching it into the gitignored .cache/ on first use, or a reason it is unavailable. */
export async function loadCorpus(): Promise<{ corpus: Corpus } | { skip: string }> {
  let bytes: Uint8Array | undefined;
  try {
    const cached = readFileSync(cacheFile);
    if (sha256(cached) === CORPUS_SHA256) bytes = cached;
  } catch {
    // not cached yet
  }
  if (!bytes) {
    try {
      const res = await fetch(CORPUS_URL, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fetched = new Uint8Array(await res.arrayBuffer());
      if (sha256(fetched) !== CORPUS_SHA256) {
        return { skip: `corpus at ${CORPUS_URL} has sha256 ${sha256(fetched)}, expected ${CORPUS_SHA256}` };
      }
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, fetched);
      bytes = fetched;
    } catch (e) {
      return { skip: `could not fetch ${CORPUS_URL} (${(e as Error).message}); run once with network access to cache it in .cache/` };
    }
  }
  const text = new TextDecoder().decode(bytes);
  // The reviver's third argument (the number's source text) exists in Node 22+, not yet in the TS lib types.
  const reviver = (_k: string, v: unknown, ctx: { source: string }): unknown => (typeof v === 'number' ? new Num(ctx.source) : v);
  const corpus = JSON.parse(text, reviver as unknown as Parameters<typeof JSON.parse>[1]) as Corpus;
  return { corpus };
}

export function caseBytes(text: string | { binary: string }): Uint8Array {
  return typeof text === 'string' ? new TextEncoder().encode(text) : new Uint8Array(Buffer.from(text.binary, 'base64'));
}

export const PRECISIONS: Record<string, 'ns' | 'us' | 'ms' | 's'> = { '1ns': 'ns', '1µs': 'us', '1ms': 'ms', '1s': 's' };
