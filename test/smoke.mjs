/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` (the TypeScript suite needs type stripping and only runs on 24+).
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { decode, decodeEntries, decodeStream, DecodeError, encode, EncodeError, parse } = await import('../dist/index.js');

test('decodes a line with every field type', () => {
  const [p] = parse('cpu,host=a,region=us f=1.5,i=-3i,u=4u,s="hi there",b=T 1700000000000000000\n');
  assert.equal(p.measurement, 'cpu');
  assert.deepEqual(p.tags, [
    { key: 'host', value: 'a' },
    { key: 'region', value: 'us' },
  ]);
  assert.deepEqual(
    p.fields.map((f) => [f.key, f.type, f.value]),
    [['f', 'float', 1.5], ['i', 'int', -3n], ['u', 'uint', 4n], ['s', 'string', 'hi there'], ['b', 'bool', true]],
  );
  assert.equal(p.timestamp, 1700000000000000000n);
});

test('applies precision and a default time', () => {
  assert.equal(parse('m v=1 5', { precision: 's' })[0].timestamp, 5000000000n);
  assert.equal(parse('m v=1', { precision: 's', defaultTime: 1999999999n })[0].timestamp, 1000000000n);
});

test('rejects with the Go decoder message, line and column', () => {
  assert.throws(
    () => parse('ok v=1\nbad v=1.2.3\n'),
    (e) => e instanceof DecodeError && e.line === 2 && e.column === 7 && e.message === 'at line 2:7: cannot parse value for field key "v": invalid float value syntax',
  );
  assert.throws(() => parse('m,a v=1'), /expected '=' after tag key "a", but got ' ' instead/);
  assert.throws(() => parse('m v=9223372036854775808i'), (e) => e instanceof DecodeError && e.outOfRange);
});

test('decodeEntries recovers after a bad line; decode stops at it', () => {
  const entries = [...decodeEntries('a v=1\nbroken\nc v=3\n')];
  assert.deepEqual(entries.map((e) => e.ok), [true, false, true]);
  assert.throws(() => [...decode('a v=1\nbroken\n')], DecodeError);
});

test('decodes chunked input', async () => {
  const names = [];
  for await (const p of decodeStream(['a v=1\nb s="x', 'y\nz" 5\nc v=2'])) names.push(p.measurement);
  assert.deepEqual(names, ['a', 'b', 'c']);
});

test('encodes and round-trips', () => {
  const line = encode({ measurement: 'a b', tags: { z: '1', a: 'x y' }, fields: { f: 1e21, n: 12n, s: 'q"\n' }, timestamp: 5n });
  assert.equal(line, 'a\\ b,a=x\\ y,z=1 f=1e+21,n=12i,s="q\\"\\n" 5\n');
  const [p] = parse(line);
  assert.equal(p.measurement, 'a b');
  assert.equal(p.fields[2].value, 'q"\n');
  assert.throws(() => encode({ measurement: '', fields: { v: 1 } }), EncodeError);
});
