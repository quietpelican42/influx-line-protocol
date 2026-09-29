import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import { decodeEntries, DecodeError, decodeStream, decodeStreamEntries } from '../src/index.ts';
import type { Entry } from '../src/index.ts';
import { genInput, mutate, PREC, Rng } from './support/gen.ts';
import { fixtureBytes } from './support/fixtures.ts';
import type { DecodeInput } from './support/fixtures.ts';
import { shape } from './support/shape.ts';

const fixtures = JSON.parse(readFileSync(new URL('fixtures/decode-inputs.json', import.meta.url), 'utf8')) as DecodeInput[];

async function collect(source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>, options = {}): Promise<Entry[]> {
  const out: Entry[] = [];
  for await (const e of decodeStreamEntries(source, options)) out.push(e);
  return out;
}

function split(r: Rng, bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const n = r.chance(0.3) ? 1 : 1 + r.int(12);
    out.push(bytes.subarray(i, i + n));
    i += n;
  }
  return out;
}

test('chunked decoding equals whole-input decoding for every fixture, one byte at a time', async () => {
  for (const f of fixtures) {
    const bytes = fixtureBytes(f);
    const options = { precision: f.precision, defaultTime: BigInt(f.defaultTime) };
    const whole = [...decodeEntries(bytes, options)].map(shape);
    const oneByte = await collect(Array.from(bytes, (b) => Uint8Array.of(b)), options);
    assert.deepEqual(oneByte.map(shape), whole, f.name);
  }
});

test('chunked decoding equals whole-input decoding for 20000 generated and mutated inputs, random splits', async () => {
  const r = new Rng(99);
  for (let i = 0; i < 20000; i++) {
    const bytes = Uint8Array.from(r.chance(0.5) ? genInput(r) : mutate(r, genInput(r)));
    const options = { precision: r.pick(PREC), defaultTime: 1234567890123456789n };
    const whole = [...decodeEntries(bytes, options)].map(shape);
    const chunked = (await collect(split(r, bytes), options)).map(shape);
    assert.deepEqual(chunked, whole, `input ${JSON.stringify(Buffer.from(bytes).toString('latin1'))}`);
  }
});

test('string chunks may split multi-byte characters and surrogate pairs', async () => {
  const text = 'métrique,k=é v="日本 😀 😀",w=1 5\nsecond,😀=x f=2\n';
  const whole = [...decodeEntries(text)].map(shape);
  for (let cut = 1; cut < text.length; cut++) {
    const got = await collect([text.slice(0, cut), text.slice(cut)]);
    assert.deepEqual(got.map(shape), whole, `cut at ${cut}`);
  }
  const bytes = new TextEncoder().encode(text);
  for (let cut = 1; cut < bytes.length; cut++) {
    const got = await collect([bytes.subarray(0, cut), bytes.subarray(cut)]);
    assert.deepEqual(got.map(shape), whole, `byte cut at ${cut}`);
  }
});

test('reads a Node Readable', async () => {
  const stream = Readable.from([Buffer.from('a v=1 1\nb,t=x v="mul'), Buffer.from('ti\nline" 2\n'), Buffer.from('c v=3')]);
  const names: string[] = [];
  for await (const p of decodeStream(stream)) names.push(`${p.measurement}@${p.line}`);
  assert.deepEqual(names, ['a@1', 'b@2', 'c@4']);
});

test('decodeStream throws the first DecodeError after yielding earlier points', async () => {
  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const p of decodeStream(['a v=1\n', 'b v=2\nbad\n', 'c v=3\n'])) seen.push(p.measurement);
  }, DecodeError);
  assert.deepEqual(seen, ['a', 'b']);
});

test('points are yielded as soon as their line is complete', async () => {
  let pulled = 0;
  async function* source(): AsyncGenerator<string> {
    pulled++;
    yield 'a v=1\n';
    pulled++;
    yield 'b v=2\n';
    pulled++;
    yield 'c v=3\n';
  }
  const it = decodeStream(source());
  const first = await it.next();
  assert.equal(first.done, false);
  assert.equal(pulled, 1);
  await it.return(undefined);
});

test('empty chunks and an empty source are fine', async () => {
  assert.deepEqual(await collect([]), []);
  assert.deepEqual(await collect(['', new Uint8Array(0), 'a v=1', '', '\n']).then((e) => e.map(shape)), [...decodeEntries('a v=1\n')].map(shape));
});
