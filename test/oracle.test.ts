import assert from 'node:assert/strict';
import test from 'node:test';
import { caseBytes, loadCorpus } from './support/corpus.ts';
import { formatReport, runDifferential } from './support/differential.ts';
import { buildOracle } from './support/oracle.ts';

const oracle = buildOracle();
const skip = 'skip' in oracle ? oracle.skip : false;
if (skip) console.warn(`SKIPPED Go differential tests: ${skip}`);

test('differential: decoder, encoder and round trip agree with the Go implementation', { skip, timeout: 600_000 }, async () => {
  assert.ok('path' in oracle);
  console.log(oracle.version);
  const loaded = await loadCorpus();
  const seeds = 'corpus' in loaded ? Object.values(loaded.corpus.decode).map((c) => caseBytes(c.input.text)) : [];
  const opts = { seed: 20260929, decodeCount: 30000, encodeCount: 10000, seeds };
  const report = runDifferential(oracle.path, opts);
  console.log(formatReport(report, opts));
  const bad = [...report.decodeMismatches, ...report.encodeMismatches, ...report.roundTripMismatches].filter((m) => m !== '(more)');
  assert.deepEqual(bad.slice(0, 5), []);
  assert.equal(report.decodeCasesMismatched, 0);
  assert.equal(report.encodeMismatches.length, 0);
  assert.equal(report.roundTripMismatches.length, 0);
  assert.ok(report.decodeCases >= 20000);
});
