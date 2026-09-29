/**
 * Compares error-message quoting (Go's %q) for every Unicode code point.
 * Each code point is used as a tag key, which the decoder quotes in
 * `expected '=' after tag key "<key>", but got ' ' instead`.
 *
 *   node scripts/sweep-quote.ts
 */
import { decodeEntries } from '../src/index.ts';
import { buildOracle, runOracle } from '../test/support/oracle.ts';

const oracle = buildOracle();
if ('skip' in oracle) {
  console.error(`cannot run: ${oracle.skip}`);
  process.exit(2);
}
console.log(oracle.version);
const points: number[] = [];
for (let cp = 0x21; cp <= 0x10ffff; cp++) {
  if ((cp >= 0xd800 && cp <= 0xdfff) || cp === 0x2c || cp === 0x3d || cp === 0x5c || cp === 0x7f) continue;
  points.push(cp);
}
let same = 0;
const bad: string[] = [];
const BATCH = 20000;
for (let off = 0; off < points.length; off += BATCH) {
  const batch = points.slice(off, off + BATCH);
  const texts = batch.map((cp) => `m,${String.fromCodePoint(cp)} v=1`);
  const want = runOracle(oracle.path, texts.map((t) => ({ op: 'decode', b64: Buffer.from(t).toString('base64'), prec: 'ns', def: '0' })));
  batch.forEach((cp, i) => {
    const [e] = [...decodeEntries(texts[i]!)];
    const got = e && !e.ok ? e.error.detail : 'no error';
    const exp = want[i].entries?.[0]?.msg;
    if (got === exp) same++;
    else if (bad.length < 10) bad.push(`U+${cp.toString(16)}: got ${got} want ${exp}`);
  });
}
console.log(`quoting: ${same}/${points.length} code points quote identically to Go's %q`);
if (bad.length) {
  console.log(bad.join('\n'));
  process.exit(1);
}
