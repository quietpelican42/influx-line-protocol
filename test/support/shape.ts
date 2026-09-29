import type { Entry } from '../../src/index.ts';

const f64 = new DataView(new ArrayBuffer(8));
export const bitsHex = (x: number): string => {
  f64.setFloat64(0, x);
  return f64.getBigUint64(0).toString(16);
};
export const hexToFloat = (h: string): number => {
  f64.setBigUint64(0, BigInt('0x' + h));
  return f64.getFloat64(0);
};

/** Serializes decoder output the way the Go oracle reports it. */
export function shape(e: Entry): unknown {
  if (!e.ok) return { k: 'e', line: e.error.line, col: e.error.column, msg: e.error.detail, oor: e.error.outOfRange };
  const p = e.point;
  return {
    k: 'p',
    name: p.measurement,
    tags: p.tags.map((t) => [t.key, t.value]),
    fields: p.fields.map((f) => [f.key, f.type, f.type === 'float' ? bitsHex(f.value) : String(f.value)]),
    ts: String(p.timestamp),
  };
}

/** Normalizes the oracle's omitempty JSON to the same shape. */
export function oracleShape(e: any): unknown {
  if (e.k === 'e') return { k: 'e', line: e.line, col: e.col, msg: e.msg, oor: !!e.oor };
  return { k: 'p', name: e.name ?? '', tags: e.tags ?? [], fields: e.fields ?? [], ts: e.ts };
}

