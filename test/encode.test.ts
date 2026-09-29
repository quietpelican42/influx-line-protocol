import assert from 'node:assert/strict';
import test from 'node:test';
import { decode, encode, EncodeError, formatFloat, parse } from '../src/index.ts';
import { genEncPoint, PREC, Rng } from './support/gen.ts';

test('encodes a point from object shorthands and sorts tags', () => {
  assert.equal(
    encode({ measurement: 'cpu', tags: { region: 'us', host: 'a b' }, fields: { load: 0.5, n: 3n, ok: true, note: 'x "y"' }, timestamp: 1700000000000000000n }),
    'cpu,host=a\\ b,region=us load=0.5,n=3i,ok=true,note="x \\"y\\"" 1700000000000000000\n',
  );
});

test('typed fields, including uint', () => {
  assert.equal(
    encode({ measurement: 'm', fields: [{ key: 'u', type: 'uint', value: 18446744073709551615n }, { key: 'i', type: 'int', value: -1n }] }),
    'm u=18446744073709551615u,i=-1i\n',
  );
  assert.equal(encode({ measurement: 'm', fields: { u: { type: 'uint', value: 7 } } }), 'm u=7u\n');
});

test('timestamps: bigint, safe-integer number, Date, precision truncates toward zero', () => {
  assert.equal(encode({ measurement: 'm', fields: { v: 1 }, timestamp: 5n }), 'm v=1 5\n');
  assert.equal(encode({ measurement: 'm', fields: { v: 1 }, timestamp: 5 }), 'm v=1 5\n');
  assert.equal(encode({ measurement: 'm', fields: { v: 1 }, timestamp: new Date(1500) }), 'm v=1 1500000000\n');
  assert.equal(encode({ measurement: 'm', fields: { v: 1 }, timestamp: 1999999999n }, { precision: 's' }), 'm v=1 1\n');
  assert.equal(encode({ measurement: 'm', fields: { v: 1 }, timestamp: -1999999999n }, { precision: 's' }), 'm v=1 -1\n');
  assert.equal(encode({ measurement: 'm', fields: { v: 1 }, timestamp: null }), 'm v=1\n');
});

test('sortTags: false requires strictly increasing keys, as the Go encoder does', () => {
  const p = { measurement: 'm', tags: [{ key: 'b', value: '1' }, { key: 'a', value: '2' }], fields: { v: 1 } };
  assert.throws(() => encode(p, { sortTags: false }), /tag key "a" out of order \(previous key "b"\)/);
  assert.equal(encode(p), 'm,a=2,b=1 v=1\n');
  assert.throws(() => encode({ ...p, tags: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] }), /out of order/);
});

test('tags sort by UTF-8 bytes, not UTF-16 units', () => {
  assert.equal(encode({ measurement: 'm', tags: { '😀': '2', '\ue000': '1' }, fields: { v: 1 } }), 'm,\ue000=1,😀=2 v=1\n');
});

test('rejects what the Go encoder rejects', () => {
  const bad = (p: Parameters<typeof encode>[0], re: RegExp): void => assert.throws(() => encode(p), (e: Error) => e instanceof EncodeError && re.test(e.message));
  bad({ measurement: '', fields: { v: 1 } }, /invalid measurement ""/);
  bad({ measurement: 'a\nb', fields: { v: 1 } }, /invalid measurement "a\\nb"/);
  bad({ measurement: 'a\\', fields: { v: 1 } }, /invalid measurement/);
  bad({ measurement: 'm', tags: { a: '' }, fields: { v: 1 } }, /invalid tag value a=""/);
  bad({ measurement: 'm', tags: { '': 'x' }, fields: { v: 1 } }, /invalid tag key ""/);
  bad({ measurement: 'm', fields: {} }, /at least one field/);
  bad({ measurement: 'm', fields: { '': 1 } }, /invalid field key ""/);
  bad({ measurement: 'm', fields: { v: NaN } }, /not finite/);
  bad({ measurement: 'm', fields: { v: Infinity } }, /not finite/);
  bad({ measurement: 'm', fields: { v: '\ud800' } }, /invalid utf-8/);
  bad({ measurement: 'm', fields: { v: 2n ** 63n } }, /out of range/);
  bad({ measurement: 'm', fields: { v: { type: 'uint', value: -1n } } }, /out of range/);
  bad({ measurement: 'm', fields: { v: 1 }, timestamp: 2n ** 63n }, /out of range/);
  bad({ measurement: 'm', fields: { v: 1 }, timestamp: 2 ** 60 + 0.5 }, /safe integer/);
});

test('deliberate deviation: a measurement starting with # is rejected because Go would read it back as a comment', () => {
  assert.throws(() => encode({ measurement: '#m', fields: { v: 1 } }), /invalid measurement "#m"/);
  assert.equal(encode({ measurement: 'm#', fields: { v: 1 } }), 'm# v=1\n');
});

test('a list encodes point by point; the error names the index like the Go encoder', () => {
  assert.equal(encode([{ measurement: 'a', fields: { v: 1 } }, { measurement: 'b', fields: { v: 2 } }]), 'a v=1\nb v=2\n');
  assert.throws(() => encode([{ measurement: 'a', fields: { v: 1 } }, { measurement: '', fields: { v: 2 } }]), (e: Error) => e.message === 'encoding point 1: invalid measurement ""');
  assert.throws(() => encode([{ measurement: '', fields: { v: 2 } }]), (e: Error) => e.message === 'invalid measurement ""');
});

test('formatFloat matches strconv.FormatFloat(x, g, -1, 64)', () => {
  const table: [number, string][] = [
    [0, '0'], [-0, '-0'], [1, '1'], [-1.5, '-1.5'], [100000, '100000'], [999999, '999999'], [1e6, '1e+06'], [123456789, '1.23456789e+08'],
    [1e21, '1e+21'], [0.0001, '0.0001'], [0.00001, '1e-05'], [0.000123, '0.000123'], [1.5e-7, '1.5e-07'], [5e-324, '5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'], [1 / 3, '0.3333333333333333'], [0.1 + 0.2, '0.30000000000000004'], [123456.7, '123456.7'],
    [2 ** 53, '9.007199254740992e+15'], [1e100, '1e+100'], [-1e-100, '-1e-100'],
  ];
  for (const [x, want] of table) assert.equal(formatFloat(x), want, String(x));
});

test('encode then decode gives the input back (random points)', () => {
  const r = new Rng(7);
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const p = genEncPoint(r);
    const prec = r.pick(PREC);
    if (p.name.startsWith('#')) continue;
    let line: string;
    try {
      line = encode(
        {
          measurement: p.name,
          tags: p.tags.map(([key, value]) => ({ key, value })),
          fields: p.fields.map(([key, type, v]) => {
            const dv = new DataView(new ArrayBuffer(8));
            switch (type) {
              case 'float':
                dv.setBigUint64(0, BigInt('0x' + v));
                return { key, type, value: dv.getFloat64(0) };
              case 'int':
              case 'uint':
                return { key, type, value: BigInt(v) };
              case 'bool':
                return { key, type, value: v === 'true' };
              default:
                return { key, type: 'string' as const, value: v };
            }
          }),
          timestamp: p.ts === null ? null : BigInt(p.ts),
        },
        { precision: prec },
      );
    } catch (e) {
      assert.ok(e instanceof EncodeError);
      continue;
    }
    const [back] = [...decode(line, { precision: prec })];
    assert.equal(back!.measurement, p.name);
    assert.deepEqual(back!.tags.map((t) => t.key).sort(), p.tags.map((t) => t[0]).sort());
    assert.equal(back!.fields.length, p.fields.length);
    checked++;
  }
  assert.ok(checked > 500, `only ${checked} points were encodable`);
});

test('parse(encode(x)) keeps multi-line strings on one line', () => {
  const line = encode({ measurement: 'm', fields: { s: 'a\nb\r\nc\td' } });
  assert.equal(line.split('\n').length, 2);
  assert.equal(parse(line)[0]!.fields[0]!.value, 'a\nb\r\nc\td');
});
