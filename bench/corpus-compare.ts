/**
 * Scores this package and, optionally, influx-line-protocol-parser 0.2.0 on the
 * official line-protocol corpus (395 valid inputs, 6,220 that must be rejected).
 *
 *   node bench/corpus-compare.ts                       # this package only
 *   node bench/corpus-compare.ts --incumbent <dir>     # dir with influx-line-protocol-parser@0.2.0 in node_modules
 *
 * The incumbent has no error reporting, no field types and no precision option,
 * so it is scored generously: a valid input counts as correct when every line
 * yields the expected measurement, tag pairs, field values (numbers compared as
 * numbers) and timestamp; an input counts as rejected only if parsing throws or
 * a line yields an empty result.
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { DecodeError, parse } from '../src/index.ts';
import type { Point } from '../src/index.ts';
import { caseBytes, loadCorpus, Num, PRECISIONS } from '../test/support/corpus.ts';
import type { CorpusPoint, DecodeCase } from '../test/support/corpus.ts';
import { compareUtf8 } from '../src/utf8.ts';

const loaded = await loadCorpus();
if ('skip' in loaded) {
  console.error(`cannot run: ${loaded.skip}`);
  process.exit(2);
}
const cases = Object.values(loaded.corpus.decode);
const valid = cases.filter((c) => c.output.error === undefined);
const invalid = cases.filter((c) => c.output.error !== undefined);

function ours(c: DecodeCase): Point[] | Error {
  try {
    const pts = parse(caseBytes(c.input.text), { precision: PRECISIONS[c.input.precision]!, defaultTime: BigInt(c.input.defaultTime.src) });
    for (const p of pts) {
      const keys = p.tags.map((t) => t.key).sort(compareUtf8);
      if (keys.some((k, i) => i > 0 && k === keys[i - 1])) throw new Error('duplicate key');
    }
    return pts.map((p) => ({ ...p, tags: [...p.tags].sort((a, b) => compareUtf8(a.key, b.key)) }));
  } catch (e) {
    if (e instanceof DecodeError || e instanceof Error) return e;
    throw e;
  }
}

function oursCorrect(c: DecodeCase): boolean {
  const got = ours(c);
  const want = c.output.result!;
  if (got instanceof Error || got.length !== want.length) return false;
  return got.every((p, i) => {
    const w: CorpusPoint = want[i]!;
    return (
      p.measurement === w.name &&
      p.timestamp === BigInt(w.time.src) &&
      p.tags.length === w.tags.length &&
      p.tags.every((t, j) => t.key === w.tags[j]!.key && t.value === w.tags[j]!.value) &&
      p.fields.length === w.fields.length &&
      p.fields.every((f, j) => {
        const [[type, raw]] = Object.entries(w.fields[j]!.value) as [[string, Num | string | boolean]];
        const v = raw instanceof Num ? raw.src : raw;
        if (f.key !== w.fields[j]!.key || f.type !== type) return false;
        return f.type === 'float' ? f.value === Number(v) : f.type === 'int' || f.type === 'uint' ? f.value === BigInt(v as string) : f.value === v;
      })
    );
  });
}

const row = (name: string, validOk: number, rejectOk: number): string =>
  `${name.padEnd(34)} valid ${String(validOk).padStart(3)}/${valid.length} (${((100 * validOk) / valid.length).toFixed(1)}%)   rejected ${String(rejectOk).padStart(4)}/${invalid.length} (${((100 * rejectOk) / invalid.length).toFixed(1)}%)`;

console.log(`corpus: ${cases.length} decode cases, ${valid.length} valid, ${invalid.length} must be rejected`);
console.log(row('influx-line-protocol (this package)', valid.filter(oursCorrect).length, invalid.filter((c) => ours(c) instanceof Error).length));

const dirIdx = process.argv.indexOf('--incumbent');
if (dirIdx >= 0) {
  const dir = resolve(process.argv[dirIdx + 1]!);
  const req = createRequire(join(dir, 'x.js'));
  const pkg = req('influx-line-protocol-parser/package.json') as { name: string; version: string };
  const { parse: theirs } = req('influx-line-protocol-parser') as { parse: (line: string) => any };
  const realError = console.error;
  console.error = () => {}; // the incumbent logs caught exceptions

  const linesOf = (c: DecodeCase): string[] =>
    new TextDecoder('utf-8').decode(caseBytes(c.input.text)).split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));

  const theirsCorrect = (c: DecodeCase): boolean => {
    const want = c.output.result!;
    const lines = linesOf(c);
    if (lines.length !== want.length) return false;
    return lines.every((line, i) => {
      let got: any;
      try {
        got = theirs(line);
      } catch {
        return false;
      }
      const w = want[i]!;
      if (got.measurement !== w.name) return false;
      const tags = (got.tags as Record<string, string>[]).map((t) => Object.entries(t)[0]!).sort((a, b) => compareUtf8(a[0], b[0]));
      if (tags.length !== w.tags.length || !tags.every(([k, v], j) => k === w.tags[j]!.key && v === w.tags[j]!.value)) return false;
      const fields = (got.fields as Record<string, unknown>[]).map((f) => Object.entries(f)[0]!);
      if (fields.length !== w.fields.length) return false;
      const fieldsOk = fields.every(([k, v], j) => {
        const [[type, raw]] = Object.entries(w.fields[j]!.value) as [[string, Num | string | boolean]];
        if (k !== w.fields[j]!.key) return false;
        return raw instanceof Num ? v === Number(raw.src) : v === raw && (type === 'string' || type === 'bool');
      });
      if (!fieldsOk) return false;
      if (got.timestamp !== undefined) return got.timestamp === Number(w.time.src);
      // No timestamp reported: right only if the line really had none (the expected time is the truncated default).
      const unit = { ns: 1n, us: 1000n, ms: 1000000n, s: 1000000000n }[PRECISIONS[c.input.precision]!];
      const def = BigInt(c.input.defaultTime.src);
      const floored = def - (((def % unit) + unit) % unit);
      return BigInt(w.time.src) === floored;
    });
  };

  const theirsRejects = (c: DecodeCase): boolean => {
    for (const line of linesOf(c)) {
      try {
        const r = theirs(line);
        if (!r || Object.keys(r).length === 0) return true;
      } catch {
        return true;
      }
    }
    return false;
  };

  const validOk = valid.filter(theirsCorrect).length;
  const rejectOk = invalid.filter(theirsRejects).length;
  console.error = realError;
  console.log(row(`${pkg.name} ${pkg.version}`, validOk, rejectOk));
}
