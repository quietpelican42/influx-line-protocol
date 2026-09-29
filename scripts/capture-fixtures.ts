/**
 * Regenerates test/fixtures/*-expected.json from the Go oracle.
 *
 *   node scripts/capture-fixtures.ts
 *
 * The inputs (decode-inputs.json, encode-inputs.json) are written by hand;
 * the expected files hold whatever the reference Go implementation did with them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildOracle, runOracle } from '../test/support/oracle.ts';
import { fixtureBytes } from '../test/support/fixtures.ts';
import type { DecodeInput, EncodeInput } from '../test/support/fixtures.ts';

const oracle = buildOracle();
if ('skip' in oracle) {
  console.error(`cannot run: ${oracle.skip}`);
  process.exit(2);
}
const dir = new URL('../test/fixtures/', import.meta.url);
const decodeInputs = JSON.parse(readFileSync(new URL('decode-inputs.json', dir), 'utf8')) as DecodeInput[];
const encodeInputs = JSON.parse(readFileSync(new URL('encode-inputs.json', dir), 'utf8')) as EncodeInput[];

const decoded = runOracle(
  oracle.path,
  decodeInputs.map((c) => ({ op: 'decode', b64: Buffer.from(fixtureBytes(c)).toString('base64'), prec: c.precision, def: c.defaultTime })),
);
const encoded = runOracle(
  oracle.path,
  encodeInputs.map((c) => ({ op: 'encode', prec: c.precision, point: c.point })),
);
const out = (name: string, cases: { name: string }[], results: unknown[]) =>
  writeFileSync(new URL(name, dir), JSON.stringify({ oracle: oracle.version, cases: cases.map((c, i) => ({ name: c.name, expected: results[i] })) }, null, 1) + '\n');
out('decode-expected.json', decodeInputs, decoded);
out('encode-expected.json', encodeInputs, encoded);
console.log(`captured ${decodeInputs.length} decode and ${encodeInputs.length} encode cases with ${oracle.version}`);
