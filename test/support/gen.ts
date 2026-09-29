/** Deterministic generators of line-protocol inputs and points for differential testing. */

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
}

const enc = new TextEncoder();
export const utf8 = (s: string): number[] => [...enc.encode(s)];

const NAME_ATOMS = [
  'cpu', 'mem', 'a', 'x', 'temp', 'host', 'region', 'value', 'v', 'k', 'métrique', '日本', '😀', 'a b', 'a,b', 'a=b', 'a\\ b',
  'a\\,b', 'a\\=b', 'a\\\\b', 'a\\', '\\', 'a"b', '#c', 'a#', "a'b", 'é', ' ', '﻿bom', '�', 'a\tb', 'a\x7fb', 'a\x00b',
  'a\\nb', 'a\\qb', '_', '1', 'true',
];

function escapeName(r: Rng, s: string, chars: string): string {
  // Usually escape correctly, sometimes not.
  if (r.chance(0.15)) return s;
  return [...s].map((c) => (chars.includes(c) ? '\\' + c : c)).join('');
}

const INT_VALUES = [
  '0', '1', '-1', '42', '007', '-0', '9223372036854775807', '9223372036854775808', '-9223372036854775808', '-9223372036854775809',
  '99999999999999999999', '99999999999999999999x', '1_0', '+1', '--1', '1.0', '1e5', '', '-', '0x10', ' ',
];
const UINT_VALUES = ['0', '1', '42', '18446744073709551615', '18446744073709551616', '-1', '+1', '1_0', '1.0', '', '99999999999999999999999', '007'];
const FLOAT_VALUES = [
  '1', '-1', '0', '-0', '1.5', '.5', '-.5', '5.', '1e5', '1E5', '1e+5', '1e-5', '1e', '1e+', '-', '.', 'e5', '1.5.5', '1..5',
  '0x1p-2', '0X1P+3', '0x1.8p1', '0x1', '0xp1', '0x.8p1', '-0x1p3', '0x1p', '0x1P1024', '0x1p-1074', '0x1p-1075', '0x0.0000000000001p-1022',
  '0x1fffffffffffffffffp0', '0x123456789abcdef01p-4', '1_000', '1_0.5e1_0', '1__0', '_1', '1_', '0x_1p0', '0x1_p0', '1e1_0', '1e_10',
  '-inf', '-Inf', '-infinity', '-INFINITY', '-infin', '-infinit', '-nan', '-NaN', '.inf', '1inf', '4.9e-324', '2.4703282292062327e-324',
  '2.4703282292062328e-324', '1.7976931348623157e308', '1.7976931348623159e308', '1e308', '1e309', '1e999', '-1e999', '1e-999', '1e99999999999999999999',
  '0e999999', '123456789012345678901234567890', '0.1234567890123456789012345678901234567890', '00001.5', '1.5e0', '1.5E-0', '3.14159',
  '1e400', '1e-400', '.e1', '1e5.5', '1ee5', '1e5e5', '1,5', '1é', 'é',
];
const BOOL_VALUES = ['t', 'T', 'true', 'True', 'TRUE', 'f', 'F', 'false', 'False', 'FALSE', 'tRUE', 'tr', 'fals', 'yes', 't1', 'trueX', 'Té'];
const STRING_BODIES = [
  '', 'x', 'hello world', 'a,b=c', 'q\\"q', 'back\\\\slash', 'nl\\nx', 'cr\\ry', 'tab\\tz', 'raw\nnewline', 'raw\r\ncrlf', 'raw\ttab',
  'esc\\qq', 'trail\\\\', 'é日本😀', '\\u00e9', 'uni\\x41', 'a\\', 'multi\nline\nvalue', '"', '\x00nul', '\x7f', 'x\\ y', '\\,',
];
const TIMESTAMPS = [
  '0', '1', '-1', '123456789', '1700000000000000000', '9223372036854775807', '9223372036854775808', '-9223372036854775808',
  '-9223372036854775809', '9223372036', '9223372037', '-9223372036', '9223372036854775', '9223372036854776', '9223372036854',
  '1e5', '1_0', '12a', '+5', '--5', '5-', '1-2', '007', '-', '-0', '99999999999999999999', 'abc', '1.5', '0x10', '12 34', '12,34',
];

function fieldVal(r: Rng): string {
  switch (r.int(6)) {
    case 0:
      return r.pick(INT_VALUES) + (r.chance(0.9) ? 'i' : '');
    case 1:
      return r.pick(UINT_VALUES) + (r.chance(0.9) ? 'u' : '');
    case 2:
    case 3:
      return r.pick(FLOAT_VALUES);
    case 4:
      return r.pick(BOOL_VALUES);
    default: {
      const body = r.pick(STRING_BODIES);
      return r.chance(0.95) ? `"${body}"` : `"${body}`;
    }
  }
}

function measurement(r: Rng): string {
  return r.chance(0.7) ? r.pick(['cpu', 'mem', 'a', 'temp']) : escapeName(r, r.pick(NAME_ATOMS), ' ,');
}
function tagKV(r: Rng): string {
  const k = r.chance(0.6) ? r.pick(['host', 'region', 'a', 'b', 'z']) : escapeName(r, r.pick(NAME_ATOMS), ',= ');
  const v = r.chance(0.6) ? r.pick(['x', 'us-west', '1', 'v']) : escapeName(r, r.pick(NAME_ATOMS), ',= ');
  return r.chance(0.03) ? k : r.chance(0.03) ? `${k}=` : `${k}=${v}`;
}
function fieldKV(r: Rng): string {
  const k = r.chance(0.6) ? r.pick(['value', 'v', 'x', 'f', 'count']) : escapeName(r, r.pick(NAME_ATOMS), ',= ');
  return r.chance(0.02) ? k : `${k}=${fieldVal(r)}`;
}
function spaces(r: Rng): string {
  return r.chance(0.9) ? ' ' : r.pick(['  ', '   ', '\t', ' \t', '']);
}

const GOOD_NAMES = ['cpu', 'mem', 'a', 'métrique', '日本', '😀', 'a b', 'a,b', 'a=b', 'a"b', "it's", 'a\\b', '\ufeffbom', 'x#y', '\u00a0'];
const GOOD_INT = ['0', '1', '-1', '42', '007', '-0', '9223372036854775807', '-9223372036854775808'];
const GOOD_UINT = ['0', '1', '42', '18446744073709551615'];
const GOOD_FLOAT = ['1', '-1.5', '.5', '5.', '1e5', '1E-5', '0x1p-2', '0x1.8p1', '1_000.5', '4.9e-324', '1.7976931348623157e308', '-0', '3.14159', '1e-999'];
const GOOD_BOOL = ['t', 'T', 'true', 'True', 'TRUE', 'f', 'F', 'false', 'False', 'FALSE'];
const GOOD_TS = ['0', '1', '-1', '123456789', '1700000000000000000', '9223372036854775807', '-9223372036854775808', '9223372036', '1700000000'];

function esc(s: string, chars: string): string {
  return [...s].map((c) => (chars.includes(c) ? '\\' + c : c)).join('');
}

/** A line that is valid apart from what mutation adds later. */
function genCleanLine(r: Rng): string {
  let s = esc(r.pick(GOOD_NAMES), ' ,');
  const nt = r.chance(0.4) ? 0 : 1 + r.int(3);
  for (let i = 0; i < nt; i++) s += ',' + esc(r.pick(GOOD_NAMES) + i, ',= ') + '=' + esc(r.pick(GOOD_NAMES), ',= ');
  s += ' ';
  const nf = 1 + r.int(4);
  const fs: string[] = [];
  for (let i = 0; i < nf; i++) {
    let v: string;
    switch (r.int(5)) {
      case 0: v = r.pick(GOOD_INT) + 'i'; break;
      case 1: v = r.pick(GOOD_UINT) + 'u'; break;
      case 2: v = r.pick(GOOD_FLOAT); break;
      case 3: v = r.pick(GOOD_BOOL); break;
      default: v = '"' + r.pick(['', 'x', 'hello world', 'a,b=c', 'q\\"q', 'back\\\\slash', 'nl\\nx', 'raw\nnewline', 'raw\r\ncrlf', 'é日本😀', 'tab\\tz']) + '"';
    }
    fs.push(esc(r.pick(['value', 'v', 'x', 'f', 'count', 'a b', 'x=y', 'é']) + i, ',= ') + '=' + v);
  }
  s += fs.join(',');
  if (r.chance(0.7)) s += ' ' + r.pick(GOOD_TS);
  return s;
}

export function genLine(r: Rng): string {
  if (r.chance(0.5)) return genCleanLine(r);
  if (r.chance(0.06)) return r.pick(['', ' ', '  ', '# comment', '#', '  # c', '# tab\there', '#é', '# c\x00', '\r']);
  let s = measurement(r);
  const nt = r.chance(0.5) ? 0 : 1 + r.int(4);
  for (let i = 0; i < nt; i++) s += ',' + tagKV(r);
  s += spaces(r);
  const nf = r.chance(0.03) ? 0 : 1 + r.int(4);
  const fs: string[] = [];
  for (let i = 0; i < nf; i++) fs.push(fieldKV(r));
  s += fs.join(r.chance(0.95) ? ',' : ', ');
  if (r.chance(0.7)) s += spaces(r) + r.pick(TIMESTAMPS);
  if (r.chance(0.08)) s += r.pick([' ', '  ', ' junk', ' 5 6', ',', '\t']);
  return s;
}

const EOLS = ['\n', '\n', '\n', '\n', '\r\n', '\r\n', '\n\n', ' \n', '\r'];

/** A multi-line input, generated from the grammar. */
export function genInput(r: Rng): number[] {
  const n = 1 + r.int(5);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(...utf8(genLine(r)));
    if (i < n - 1 || r.chance(0.7)) out.push(...utf8(r.pick(EOLS)));
  }
  return out;
}

const TOKENS = [
  '\\', '\\\\', '"', ',', ' ', '=', '\n', '\r', '\r\n', '#', 'i', 'u', 't', 'f', 'e', '.', '-', '0', '9', ' ', '\t', '\x00', '\x7f',
  '\\ ', '\\,', '\\=', '\\"', '\\n', ',=', ' ,', '=,', 'é', ' ', '﻿', '😀', 'x', 'true', 'inf', '_', '+', 'p', 'x',
];
const HIGH = [0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xe0, 0xed, 0xa0, 0xf0, 0xf4, 0xf5, 0xff, 0x9f, 0x8f, 0x90];

/** Applies 1-4 random byte-level edits. */
export function mutate(r: Rng, src: number[]): number[] {
  let b = [...src];
  const n = 1 + r.int(4);
  for (let i = 0; i < n; i++) {
    const pos = b.length === 0 ? 0 : r.int(b.length + 1);
    switch (r.int(8)) {
      case 0:
        b.splice(pos, 1);
        break;
      case 1:
        b.splice(pos, 0, r.int(256));
        break;
      case 2:
        if (pos < b.length) b[pos] = r.int(256);
        break;
      case 3:
        b.splice(pos, 0, ...utf8(r.pick(TOKENS)));
        break;
      case 4:
        b.splice(pos, 0, r.pick(HIGH));
        break;
      case 5:
        b = b.slice(0, pos);
        break;
      case 6: {
        const len = r.int(8);
        b.splice(pos, 0, ...b.slice(pos, pos + len));
        break;
      }
      default:
        if (pos < b.length) b[pos] = r.pick(utf8(r.pick(TOKENS)).concat([0x20, 0x2c, 0x3d, 0x22, 0x5c, 0x0a]));
    }
  }
  return b;
}

export type Prec = 'ns' | 'us' | 'ms' | 's';
export const PREC: Prec[] = ['ns', 'us', 'ms', 's'];

export function genDefaultTime(r: Rng): bigint {
  const limit = 9_000_000_000_000_000_000n;
  switch (r.int(5)) {
    case 0:
      return 0n;
    case 1:
      return BigInt(r.int(2_000_000_000)) * 1_000_000_000n + BigInt(r.int(1_000_000_000));
    case 2:
      return -(BigInt(r.int(2_000_000_000)) * 1_000_000_000n + BigInt(r.int(1_000_000_000)));
    case 3:
      return limit - BigInt(r.int(1000));
    default:
      return -limit + BigInt(r.int(1000));
  }
}

// ---- encoder inputs ---------------------------------------------------------

export interface EncPoint {
  name: string;
  tags: [string, string][];
  fields: [string, 'float' | 'int' | 'uint' | 'string' | 'bool', string][]; // float value as hex bits
  ts: string | null;
}

const ENC_NAMES = [
  ...NAME_ATOMS.filter((s) => !s.includes('\x00')), '', 'plain', 'with space', 'with,comma', 'with=eq', 'a\\', 'tab\tx', 'nl\nx',
  'quote"q', 'k ', 'z', 'Z', 'aa', 'é', 'e', '￿', '', '😀', 'ab', 'a b c', ',', '=', ' ',
];

function bitsHex(x: number): string {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16);
}

export function genFloat(r: Rng): number {
  switch (r.int(8)) {
    case 0:
      return r.pick([0, -0, 1, -1, 0.5, 100000, 999999, 1000000, 1e21, 1e-4, 1e-5, 0.0001234, 123456.7, 1234567.8, 5e-324, 1.7976931348623157e308, 0.1, 0.3, 1 / 3, 2 ** 53, 2 ** 63, 1e15, 1e16, 1e20, 1.5e300]);
    case 1:
      return r.int(2_000_000) - 1_000_000;
    case 2:
      return (r.int(2_000_000) - 1_000_000) / 10 ** r.int(9);
    case 3:
      return r.next() * 10 ** (r.int(60) - 30) * (r.chance(0.5) ? -1 : 1);
    case 4: {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setUint32(0, (r.next() * 4294967296) >>> 0);
      dv.setUint32(4, (r.next() * 4294967296) >>> 0);
      return dv.getFloat64(0); // any bit pattern, including NaN and infinities
    }
    case 5:
      return 10 ** (r.int(40) - 20);
    case 6:
      return Number(`${1 + r.int(9)}e${r.int(600) - 300}`);
    default:
      return r.next();
  }
}

function genStr(r: Rng): string {
  return r.chance(0.5) ? r.pick(STRING_BODIES).replace(/\\(.)/g, '$1') : r.pick(ENC_NAMES);
}

export function genEncPoint(r: Rng): EncPoint {
  const keyPool = ENC_NAMES;
  const name = r.chance(0.85) ? r.pick(['cpu', 'mem', 'a b', 'x,y']) : r.pick(keyPool);
  const nt = r.chance(0.4) ? 0 : 1 + r.int(4);
  const tags: [string, string][] = [];
  for (let i = 0; i < nt; i++) {
    tags.push([r.chance(0.7) ? r.pick(['a', 'b', 'c', 'host', 'z', 'é', 'A']) : r.pick(keyPool), r.chance(0.7) ? r.pick(['x', 'y', 'us west', 'a,b', 'k=v']) : r.pick(keyPool)]);
  }
  if (r.chance(0.6)) tags.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // mostly ordered (UTF-16 order, so sometimes wrong)
  const nf = r.chance(0.04) ? 0 : 1 + r.int(4);
  const fields: EncPoint['fields'] = [];
  for (let i = 0; i < nf; i++) {
    const key = r.chance(0.7) ? r.pick(['value', 'v', 'f', 'count', 'a b', 'x=y']) : r.pick(keyPool);
    switch (r.int(5)) {
      case 0:
        fields.push([key, 'float', bitsHex(genFloat(r))]);
        break;
      case 1: {
        const v = r.chance(0.3) ? r.pick(['0', '-1', '9223372036854775807', '-9223372036854775808']) : String(r.int(2_000_000) - 1_000_000);
        fields.push([key, 'int', v]);
        break;
      }
      case 2:
        fields.push([key, 'uint', r.chance(0.3) ? r.pick(['0', '18446744073709551615']) : String(r.int(2_000_000))]);
        break;
      case 3:
        fields.push([key, 'string', genStr(r)]);
        break;
      default:
        fields.push([key, 'bool', r.chance(0.5) ? 'true' : 'false']);
    }
  }
  const ts = r.chance(0.3)
    ? null
    : r.pick(['0', '1', '-1', '1700000000123456789', '9223372036854775807', '-9223372036854775808', String(r.int(2_000_000_000) * 1000), '-1999', '1999', '-1000000001']);
  return { name, tags, fields, ts };
}
