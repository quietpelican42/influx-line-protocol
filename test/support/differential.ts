import { decodeEntries, encode } from '../../src/index.ts';
import type { Entry, Field, PointInput } from '../../src/index.ts';
import { genDefaultTime, genEncPoint, genInput, mutate, PREC, Rng } from './gen.ts';
import type { EncPoint, Prec } from './gen.ts';
import { runOracle } from './oracle.ts';
import { hexToFloat, oracleShape, shape } from './shape.ts';

export interface Report {
  decodeCases: number;
  decodeEntriesCompared: number;
  decodePointsAgreeing: number;
  decodeErrorsAgreeing: number;
  decodeMismatches: string[];
  decodeCasesMismatched: number;
  encodeCases: number;
  encodeAccepted: number;
  encodeRejected: number;
  /** Points the Go encoder accepts but this one rejects on purpose (measurement starting with '#'). */
  encodeDeviations: number;
  encodeMismatches: string[];
  roundTripChecked: number;
  roundTripMismatches: string[];
}

export interface Options {
  seed: number;
  decodeCount: number;
  encodeCount: number;
  /** Extra decode inputs (for example corpus texts) that are also mutated. */
  seeds?: Uint8Array[];
}

const show = (b: Uint8Array | number[]): string => JSON.stringify(Buffer.from(b).toString('latin1'));

export function runDifferential(oracle: string, opts: Options): Report {
  const r = new Rng(opts.seed);
  const report: Report = {
    decodeCases: 0, decodeEntriesCompared: 0, decodePointsAgreeing: 0, decodeErrorsAgreeing: 0, decodeMismatches: [], decodeCasesMismatched: 0,
    encodeCases: 0, encodeAccepted: 0, encodeRejected: 0, encodeDeviations: 0, encodeMismatches: [], roundTripChecked: 0, roundTripMismatches: [],
  };

  // ---- decode ----
  const seeds = opts.seeds ?? [];
  const inputs: { bytes: Uint8Array; prec: Prec; def: bigint }[] = [];
  for (let i = 0; i < opts.decodeCount; i++) {
    let bytes: number[];
    const m = r.int(10);
    if (m < 4) bytes = genInput(r);
    else if (m < 8 || seeds.length === 0) bytes = mutate(r, genInput(r));
    else bytes = mutate(r, [...r.pick(seeds)]);
    inputs.push({ bytes: Uint8Array.from(bytes), prec: r.pick(PREC), def: genDefaultTime(r) });
  }
  const BATCH = 5000;
  for (let off = 0; off < inputs.length; off += BATCH) {
    const batch = inputs.slice(off, off + BATCH);
    const want = runOracle(
      oracle,
      batch.map((c) => ({ op: 'decode', b64: Buffer.from(c.bytes).toString('base64'), prec: c.prec, def: c.def.toString() })),
    );
    batch.forEach((c, i) => {
      const got = [...decodeEntries(c.bytes, { precision: c.prec, defaultTime: c.def })].map(shape);
      const exp = ((want[i].entries ?? []) as any[]).map(oracleShape);
      report.decodeCases++;
      let bad = false;
      const n = Math.max(got.length, exp.length);
      for (let k = 0; k < n; k++) {
        report.decodeEntriesCompared++;
        if (JSON.stringify(got[k]) === JSON.stringify(exp[k])) {
          if ((exp[k] as any).k === 'p') report.decodePointsAgreeing++;
          else report.decodeErrorsAgreeing++;
        } else bad = true;
      }
      if (bad) {
        report.decodeCasesMismatched++;
        if (report.decodeMismatches.length < 15) {
          report.decodeMismatches.push(`input ${show(c.bytes)} prec=${c.prec} def=${c.def}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(exp)}`);
        }
      }
    });
  }

  // ---- encode ----
  const points: { p: EncPoint; prec: Prec }[] = [];
  for (let i = 0; i < opts.encodeCount; i++) points.push({ p: genEncPoint(r), prec: r.pick(PREC) });
  for (let off = 0; off < points.length; off += BATCH) {
    const batch = points.slice(off, off + BATCH);
    const want = runOracle(
      oracle,
      batch.map(({ p, prec }) => ({ op: 'encode', prec, point: { name: p.name, tags: p.tags, fields: p.fields, ts: p.ts } })),
    );
    const roundTrips: { line: string; p: EncPoint; prec: Prec; def: bigint }[] = [];
    batch.forEach(({ p, prec }, i) => {
      report.encodeCases++;
      const input: PointInput = {
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
              return { key, type, value: v };
          }
        }),
        timestamp: p.ts === null ? null : BigInt(p.ts),
      };
      let out: string | undefined;
      let err: string | undefined;
      try {
        out = encode(input, { precision: prec, sortTags: false });
      } catch (e) {
        err = (e as Error).message;
      }
      const w = want[i];
      let ok: boolean;
      if (p.name.startsWith('#')) {
        ok = err !== undefined && err.startsWith('invalid measurement');
        if (ok) report.encodeDeviations++;
        if (w.ok) w.ok = false; // not comparable, and nothing to round-trip
        w.err = err;
        if (ok) return;
      } else if (w.ok) {
        ok = out === w.out;
        if (out !== undefined) report.encodeAccepted++;
      } else {
        // Non-finite floats have their own message on each side; everything else must match exactly.
        ok = err !== undefined && (w.err === 'invalid field value' || err === w.err);
        if (err !== undefined) report.encodeRejected++;
      }
      if (!ok && report.encodeMismatches.length < 15) {
        report.encodeMismatches.push(`point ${JSON.stringify(p)} prec=${prec}\n  got  ${JSON.stringify(out ?? err)}\n  want ${JSON.stringify(w.ok ? w.out : w.err)}`);
      } else if (!ok) report.encodeMismatches.push('(more)');
      if (out !== undefined && w.ok) roundTrips.push({ line: out, p, prec, def: genDefaultTime(r) });
    });

    // The Go decoder must read back exactly what we wrote.
    const back = runOracle(
      oracle,
      roundTrips.map((c) => ({ op: 'decode', b64: Buffer.from(c.line).toString('base64'), prec: c.prec, def: c.def.toString() })),
    );
    roundTrips.forEach((c, i) => {
      report.roundTripChecked++;
      const entries = ((back[i].entries ?? []) as any[]).map(oracleShape) as any[];
      const mult = { ns: 1n, us: 1000n, ms: 1000000n, s: 1000000000n }[c.prec];
      let ts: bigint;
      if (c.p.ts === null) ts = c.def / mult * mult - (c.def % mult < 0n ? mult : 0n);
      else ts = BigInt(c.p.ts) / mult * mult;
      const want = {
        k: 'p', name: c.p.name,
        tags: [...c.p.tags].map(([k, v]) => [k, v]),
        fields: c.p.fields.map(([k, t, v]) => [k, t, v]),
        ts: String(ts),
      };
      // Tags come back in written order (which we required to be sorted); NaN-free by construction.
      if (entries.length !== 1 || JSON.stringify(entries[0]) !== JSON.stringify(want)) {
        if (report.roundTripMismatches.length < 15) report.roundTripMismatches.push(`line ${JSON.stringify(c.line)}\n  back ${JSON.stringify(entries)}\n  want ${JSON.stringify(want)}`);
        else report.roundTripMismatches.push('(more)');
      }
    });
  }
  return report;
}

export function formatReport(rep: Report, opts: Options): string {
  return [
    `seed ${opts.seed}`,
    `decode: ${rep.decodeCases - rep.decodeCasesMismatched}/${rep.decodeCases} inputs identical to the Go decoder ` +
      `(${rep.decodeEntriesCompared} entries: ${rep.decodePointsAgreeing} points and ${rep.decodeErrorsAgreeing} errors matched exactly, including line, column and message)`,
    `encode: ${rep.encodeCases - rep.encodeMismatches.length - rep.encodeDeviations}/${rep.encodeCases - rep.encodeDeviations} comparable points identical to the Go encoder (${rep.encodeAccepted} accepted, ${rep.encodeRejected} rejected, plus ${rep.encodeDeviations} '#' measurements rejected on purpose)`,
    `round trip: ${rep.roundTripChecked - rep.roundTripMismatches.length}/${rep.roundTripChecked} encoder outputs decoded back exactly by the Go decoder`,
  ].join('\n');
}
