import assert from 'node:assert/strict';
import test from 'node:test';
import { decode, decodeEntries, DecodeError, parse } from '../src/index.ts';

test('decodes a full line with every field type', () => {
  const [p] = parse('cpu,host=a,region=us-west f=1.5,i=-3i,u=4u,s="hi there",b=T 1700000000000000000\n');
  assert.deepEqual(p, {
    measurement: 'cpu',
    tags: [
      { key: 'host', value: 'a' },
      { key: 'region', value: 'us-west' },
    ],
    fields: [
      { key: 'f', type: 'float', value: 1.5 },
      { key: 'i', type: 'int', value: -3n },
      { key: 'u', type: 'uint', value: 4n },
      { key: 's', type: 'string', value: 'hi there' },
      { key: 'b', type: 'bool', value: true },
    ],
    timestamp: 1700000000000000000n,
    line: 1,
  });
});

test('64-bit integers stay exact', () => {
  const [p] = parse('m a=9223372036854775807i,b=-9223372036854775808i,c=18446744073709551615u');
  assert.deepEqual(
    p!.fields.map((f) => f.value),
    [9223372036854775807n, -9223372036854775808n, 18446744073709551615n],
  );
});

test('no timestamp gives null unless a default is supplied, and the default is truncated to the precision', () => {
  assert.equal(parse('m v=1')[0]!.timestamp, null);
  assert.equal(parse('m v=1', { defaultTime: 1234567891n, precision: 'us' })[0]!.timestamp, 1234567000n);
  assert.equal(parse('m v=1', { defaultTime: new Date(1500), precision: 's' })[0]!.timestamp, 1000000000n);
  assert.equal(parse('m v=1', { defaultTime: -1999999n, precision: 'ms' })[0]!.timestamp, -2000000n);
});

test('timestamps are scaled by the precision', () => {
  assert.equal(parse('m v=1 5', { precision: 's' })[0]!.timestamp, 5000000000n);
  assert.equal(parse('m v=1 5', { precision: 'ms' })[0]!.timestamp, 5000000n);
  assert.equal(parse('m v=1 5', { precision: 'us' })[0]!.timestamp, 5000n);
  assert.equal(parse('m v=1 5', { precision: 'µs' })[0]!.timestamp, 5000n);
  assert.equal(parse('m v=1 -5')[0]!.timestamp, -5n);
});

test('points carry the line they start on, counting comments, blanks and multi-line strings', () => {
  const pts = parse('# c\n\na v=1\nb s="x\ny",t=1\n\nc v=2\n');
  assert.deepEqual(pts.map((p) => [p.measurement, p.line]), [['a', 3], ['b', 4], ['c', 7]]);
});

test('bytes and strings decode the same', () => {
  const text = 'métrique,k=é v="日本 😀"\n';
  assert.deepEqual(parse(text), parse(new TextEncoder().encode(text)));
  assert.deepEqual(parse(text), parse(new TextEncoder().encode(text).buffer as ArrayBuffer));
  assert.deepEqual(parse(text), parse(Buffer.from(text)));
});

test('a byte-order mark is kept in the measurement, as in Go', () => {
  assert.equal(parse('\ufeffcpu v=1')[0]!.measurement, '\ufeffcpu');
});

test('invalid UTF-8 in bytes is rejected', () => {
  assert.throws(() => parse(Uint8Array.of(0x6d, 0x20, 0x73, 0x3d, 0x22, 0xff, 0x22)), /invalid utf-8 sequence in token "\\xff"/);
});

test('tags are returned in written order; duplicates and disorder are not errors', () => {
  const [p] = parse('m,z=1,a=2,a=3 v=1');
  assert.deepEqual(p!.tags.map((t) => t.key + t.value), ['z1', 'a2', 'a3']);
});

test('DecodeError carries line, column, detail and the out-of-range flag', () => {
  assert.throws(
    () => parse('ok v=1\nbad v=1.2.3\n'),
    (e: unknown) => {
      assert.ok(e instanceof DecodeError);
      assert.equal(e.line, 2);
      assert.equal(e.column, 7);
      assert.equal(e.detail, 'cannot parse value for field key "v": invalid float value syntax');
      assert.equal(e.message, `at line 2:7: ${e.detail}`);
      assert.equal(e.outOfRange, false);
      return true;
    },
  );
  assert.throws(() => parse('m v=1e999'), (e: unknown) => e instanceof DecodeError && e.outOfRange);
  assert.throws(() => parse('m v=1 99999999999999999999'), (e: unknown) => e instanceof DecodeError && e.outOfRange);
});

test('decode() yields the points before the first bad line, then throws', () => {
  const seen: string[] = [];
  assert.throws(() => {
    for (const p of decode('a v=1\nb v=2\nbroken\nc v=3\n')) seen.push(p.measurement);
  }, DecodeError);
  assert.deepEqual(seen, ['a', 'b']);
});

test('decodeEntries() reports bad lines and carries on with the next one', () => {
  const entries = [...decodeEntries('a v=1\nbroken\nc v=3\nd v=\ne v=5\n')];
  assert.deepEqual(entries.map((e) => (e.ok ? e.point.measurement : `error@${e.error.line}`)), ['a', 'error@2', 'c', 'error@4', 'e']);
});

test('a string field may span lines; the line number after it stays correct', () => {
  const entries = [...decodeEntries('a s="1\n2\n3"\nb v=x\n')];
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.ok, true);
  const bad = entries[1]!;
  assert.ok(!bad.ok);
  assert.equal(bad.error.line, 4);
});

test('backslash escapes per component', () => {
  const [p] = parse('a\\ b\\,c,k\\ 1\\,\\==v\\ 1\\,\\= f\\ 1\\,\\==1,s="q\\"\\\\\\n\\r\\t\\x"');
  assert.equal(p!.measurement, 'a b,c');
  assert.deepEqual(p!.tags, [{ key: 'k 1,=', value: 'v 1,=' }]);
  assert.equal(p!.fields[0]!.key, 'f 1,=');
  assert.equal(p!.fields[1]!.value, 'q"\\\n\r\t\\x');
});

test('Go quirk: a backslash before an unescapable character stays, so `\\\\ ` escapes the space', () => {
  assert.equal(parse('a\\\\ b v=1').length, 1);
  assert.equal(parse('a\\\\ b v=1')[0]!.measurement, 'a\\ b');
});

test('empty and comment-only input give no points', () => {
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse('\n\n# only a comment\n'), []);
});

test('line endings: LF, CRLF and a missing final newline', () => {
  assert.equal(parse('a v=1\r\nb v=2\r\nc v=3').length, 3);
});

test('a lone carriage return is an error, not a line ending', () => {
  const entries = [...decodeEntries('a v=1\rb v=2\n')];
  assert.ok(entries.some((e) => !e.ok));
});
