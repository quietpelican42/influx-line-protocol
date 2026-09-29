/**
 * Differential fuzzing against the Go oracle.
 *
 *   node scripts/fuzz.ts [--seed N] [--decode N] [--encode N]
 */
import { caseBytes, loadCorpus } from '../test/support/corpus.ts';
import { formatReport, runDifferential } from '../test/support/differential.ts';
import { buildOracle } from '../test/support/oracle.ts';

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
}

const oracle = buildOracle();
if ('skip' in oracle) {
  console.error(`cannot run: ${oracle.skip}`);
  process.exit(2);
}
console.log(oracle.version);
const loaded = await loadCorpus();
const seeds = 'corpus' in loaded ? Object.values(loaded.corpus.decode).map((c) => caseBytes(c.input.text)) : [];
const opts = { seed: arg('seed', 1), decodeCount: arg('decode', 100000), encodeCount: arg('encode', 20000), seeds };
const report = runDifferential(oracle.path, opts);
console.log(formatReport(report, opts));
const bad = [...report.decodeMismatches, ...report.encodeMismatches, ...report.roundTripMismatches].filter((m) => m !== '(more)');
if (bad.length) {
  console.log('\nfirst mismatches:\n' + bad.slice(0, 10).join('\n'));
  process.exit(1);
}
