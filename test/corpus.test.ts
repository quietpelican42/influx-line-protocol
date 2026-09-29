import assert from 'node:assert/strict';
import test from 'node:test';
import { DecodeError, encode, parse } from '../src/index.ts';
import type { Field, Point } from '../src/index.ts';
import { compareUtf8 } from '../src/utf8.ts';
import { caseBytes, CORPUS_COMMIT, loadCorpus, Num, PRECISIONS } from './support/corpus.ts';
import type { CorpusPoint } from './support/corpus.ts';

const loaded = await loadCorpus();
const skip = 'skip' in loaded ? loaded.skip : false;
if (skip) console.warn(`SKIPPED official corpus tests: ${skip}`);

/** The Go corpus harness sorts tags and rejects duplicate tag keys itself. */
function normalize(points: Point[]): Point[] {
  return points.map((p) => {
    const tags = [...p.tags].sort((a, b) => compareUtf8(a.key, b.key));
    for (let i = 1; i < tags.length; i++) {
      if (tags[i - 1]!.key === tags[i]!.key) throw new Error(`duplicate key ${tags[i]!.key}`);
    }
    return { ...p, tags };
  });
}

function sameField(got: Field, want: CorpusPoint['fields'][number]): boolean {
  if (got.key !== want.key) return false;
  const [[type, raw]] = Object.entries(want.value) as [[string, Num | string | boolean]];
  if (type !== got.type) return false;
  switch (got.type) {
    case 'float':
      return got.value === Number((raw as Num).src);
    case 'int':
    case 'uint':
      return got.value === BigInt((raw as Num).src);
    default:
      return got.value === raw;
  }
}

function samePoint(got: Point, want: CorpusPoint): boolean {
  return (
    got.measurement === want.name &&
    got.timestamp === BigInt(want.time.src) &&
    got.tags.length === want.tags.length &&
    got.tags.every((t, i) => t.key === want.tags[i]!.key && t.value === want.tags[i]!.value) &&
    got.fields.length === want.fields.length &&
    got.fields.every((f, i) => sameField(f, want.fields[i]!))
  );
}

test('official corpus: every decode case matches', { skip }, () => {
  assert.ok('corpus' in loaded);
  const cases = Object.values(loaded.corpus.decode);
  let valid = 0;
  let validOk = 0;
  let rejects = 0;
  let rejectsOk = 0;
  const failures: string[] = [];
  for (const c of cases) {
    const bytes = caseBytes(c.input.text);
    const options = { precision: PRECISIONS[c.input.precision]!, defaultTime: BigInt(c.input.defaultTime.src) };
    let got: Point[] | Error;
    try {
      got = normalize(parse(bytes, options));
    } catch (e) {
      if (!(e instanceof DecodeError) && !(e instanceof Error && e.message.startsWith('duplicate key'))) throw e;
      got = e;
    }
    if (c.output.error !== undefined) {
      rejects++;
      if (got instanceof Error) rejectsOk++;
      else failures.push(`${c.input.key}: accepted, want error ${c.output.error}`);
    } else {
      valid++;
      const want = c.output.result!;
      if (!(got instanceof Error) && got.length === want.length && got.every((p, i) => samePoint(p, want[i]!))) validOk++;
      else failures.push(`${c.input.key}: ${got instanceof Error ? got.message : 'wrong result'}`);
    }
  }
  console.log(
    `corpus @ ${CORPUS_COMMIT.slice(0, 8)} decode: valid ${validOk}/${valid}, must-reject ${rejectsOk}/${rejects}, total ${validOk + rejectsOk}/${cases.length}`,
  );
  assert.deepEqual(failures.slice(0, 10), []);
  assert.equal(validOk + rejectsOk, cases.length);
  assert.equal(cases.length, 6615);
});

test('official corpus: every encode case matches and round-trips', { skip }, () => {
  assert.ok('corpus' in loaded);
  const cases = Object.values(loaded.corpus.encode);
  let ok = 0;
  const failures: string[] = [];
  for (const c of cases) {
    const p = c.input.point;
    const precision = PRECISIONS[c.input.precision]!;
    let out: string | undefined;
    let err: Error | undefined;
    try {
      out = encode(
        {
          measurement: p.name,
          tags: p.tags,
          fields: p.fields.map((f) => {
            const [[type, raw]] = Object.entries(f.value) as [[Field['type'], Num | string | boolean]];
            const value = raw instanceof Num ? (type === 'float' ? Number(raw.src) : BigInt(raw.src)) : raw;
            return { key: f.key, type, value } as Field;
          }),
          timestamp: BigInt(p.time.src),
        },
        { precision, sortTags: false },
      );
      out = out.replace(/\n$/, '');
    } catch (e) {
      err = e as Error;
    }
    if (out !== undefined) {
      // Whatever we produced must decode back to the input point.
      const back = normalize(parse(out, { precision }));
      const want = { ...p, tags: [...p.tags].sort((a, b) => compareUtf8(a.key, b.key)) };
      if (back.length !== 1 || !samePoint(back[0]!, want)) failures.push(`${c.input.key}: round trip differs`);
    }
    if (c.output.error !== undefined) {
      if (err) ok++;
      else failures.push(`${c.input.key}: encoded, want error ${c.output.error}`);
    } else if (out === c.output.result) ok++;
    else failures.push(`${c.input.key}: got ${out ?? err?.message} want ${c.output.result}`);
  }
  console.log(`corpus @ ${CORPUS_COMMIT.slice(0, 8)} encode: ${ok}/${cases.length}`);
  assert.deepEqual(failures.slice(0, 10), []);
});
