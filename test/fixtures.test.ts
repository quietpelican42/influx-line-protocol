import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeEntries, encode } from '../src/index.ts';
import type { Field, PointInput } from '../src/index.ts';
import { fixtureBytes, type DecodeInput, type EncodeInput } from './support/fixtures.ts';
import { hexToFloat, oracleShape, shape } from './support/shape.ts';

const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')) as T;

const decodeInputs = load<DecodeInput[]>('decode-inputs.json');
const decodeExpected = load<{ oracle: string; cases: { name: string; expected: { entries?: any[] } }[] }>('decode-expected.json');
const encodeInputs = load<EncodeInput[]>('encode-inputs.json');
const encodeExpected = load<{ cases: { name: string; expected: { ok: boolean; out?: string; err?: string } }[] }>('encode-expected.json');

test('fixture files line up', () => {
  assert.deepEqual(decodeInputs.map((c) => c.name), decodeExpected.cases.map((c) => c.name));
  assert.deepEqual(encodeInputs.map((c) => c.name), encodeExpected.cases.map((c) => c.name));
  assert.ok(decodeInputs.length >= 100);
});

for (const [i, input] of decodeInputs.entries()) {
  test(`decode fixture: ${input.name}`, () => {
    const got = [...decodeEntries(fixtureBytes(input), { precision: input.precision, defaultTime: BigInt(input.defaultTime) })].map(shape);
    const want = (decodeExpected.cases[i]!.expected.entries ?? []).map(oracleShape);
    assert.deepEqual(got, want);
  });
}

for (const [i, input] of encodeInputs.entries()) {
  test(`encode fixture: ${input.name}`, () => {
    const p = input.point;
    const point: PointInput = {
      measurement: p.name,
      tags: p.tags.map(([key, value]) => ({ key, value })),
      fields: p.fields.map(([key, type, v]): Field => {
        switch (type) {
          case 'float':
            return { key, type, value: hexToFloat(v) };
          case 'int':
          case 'uint':
            return { key, type, value: BigInt(v) };
          case 'bool':
            return { key, type, value: v === 'true' };
          default:
            return { key, type: 'string', value: v };
        }
      }),
      timestamp: p.ts === null ? null : BigInt(p.ts),
    };
    const want = encodeExpected.cases[i]!.expected;
    if (want.ok) {
      assert.equal(encode(point, { precision: input.precision, sortTags: false }), want.out);
    } else {
      assert.throws(() => encode(point, { precision: input.precision, sortTags: false }), (e: Error) => {
        assert.equal(e.name, 'EncodeError');
        // Non-finite floats are reported with our own wording.
        if (want.err !== 'invalid field value') assert.equal(e.message, want.err);
        return true;
      });
    }
  });
}
