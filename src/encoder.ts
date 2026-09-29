/*
 * Encoder modeled on github.com/influxdata/line-protocol/v2/lineprotocol
 * (encoder.go, escape.go, value.go). Copyright (c) 2021 InfluxData Inc.
 * (MIT license, see LICENSE-line-protocol). It applies the same validity rules
 * and produces the same bytes, so the Go decoder round-trips the output.
 */
import { EncodeError } from './errors.ts';
import { quoteString } from './quote.ts';
import { compareUtf8, isWellFormed } from './utf8.ts';
import type { Field, Precision, Tag } from './types.ts';

/** Shorthand field values: number is a float, bigint an int, plus string and boolean. */
export type FieldInput =
  | number
  | bigint
  | string
  | boolean
  | { type: 'float'; value: number }
  | { type: 'int'; value: bigint | number }
  | { type: 'uint'; value: bigint | number }
  | { type: 'string'; value: string }
  | { type: 'bool'; value: boolean };

export interface PointInput {
  measurement: string;
  tags?: Tag[] | Record<string, string>;
  /** An array of typed fields, or an object using the shorthand values of `FieldInput`. */
  fields: Field[] | Record<string, FieldInput>;
  /** Nanoseconds since the epoch, or a `Date`. Omit or `null` for no timestamp. */
  timestamp?: bigint | number | Date | null;
}

export interface EncodeOptions {
  /** Unit to write timestamps in (they are truncated toward zero). Default `'ns'`. */
  precision?: Precision;
  /**
   * Sort tags by key (UTF-8 byte order) before writing. Default `true`.
   * When false, tags must already be in strictly increasing key order, as the
   * Go encoder requires, or encoding fails.
   */
  sortTags?: boolean;
}

const MAX_INT64 = (1n << 63n) - 1n;
const MIN_INT64 = -(1n << 63n);
const MAX_UINT64 = (1n << 64n) - 1n;

function validMeasurementOrKey(s: string): boolean {
  if (s === '') return false;
  if (!isWellFormed(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return s.charCodeAt(s.length - 1) !== 0x5c;
}

/**
 * A measurement starting with `#` is written as a comment line by the Go
 * encoder and skipped by the Go decoder, so the point is lost. This encoder
 * rejects it instead.
 */
function validMeasurement(s: string): boolean {
  return validMeasurementOrKey(s) && s.charCodeAt(0) !== 0x23;
}

const escMeasurement = (s: string): string => s.replace(/[ ,]/g, '\\$&');
const escKey = (s: string): string => s.replace(/[,= ]/g, '\\$&');

function escString(s: string): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep: string | undefined;
    if (c === 0x5c) rep = '\\\\';
    else if (c === 0x22) rep = '\\"';
    else if (c === 0x0a) rep = '\\n';
    else if (c === 0x0d) rep = '\\r';
    else if (c === 0x09) rep = '\\t';
    if (rep !== undefined) {
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return out + s.slice(last);
}

/** Go's strconv.FormatFloat(x, 'g', -1, 64). */
export function formatFloat(x: number): string {
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const neg = x < 0;
  const [mant, e] = Math.abs(x).toExponential().split('e') as [string, string];
  const digits = mant.replace('.', '');
  const dp = Number(e) + 1;
  const exp = dp - 1;
  let out: string;
  if (exp < -4 || exp >= 6) {
    out = digits[0]! + (digits.length > 1 ? '.' + digits.slice(1) : '');
    const ae = Math.abs(exp);
    out += 'e' + (exp < 0 ? '-' : '+') + (ae < 10 ? '0' + ae : String(ae));
  } else if (dp > 0) {
    const intPart = digits.length >= dp ? digits.slice(0, dp) : digits + '0'.repeat(dp - digits.length);
    const frac = digits.length > dp ? digits.slice(dp) : '';
    out = intPart + (frac ? '.' + frac : '');
  } else {
    out = '0.' + '0'.repeat(-dp) + digits;
  }
  return neg ? '-' + out : out;
}

function normalizeField(key: string, v: FieldInput): Field {
  switch (typeof v) {
    case 'number':
      return { key, type: 'float', value: v };
    case 'bigint':
      return { key, type: 'int', value: v };
    case 'string':
      return { key, type: 'string', value: v };
    case 'boolean':
      return { key, type: 'bool', value: v };
  }
  switch (v.type) {
    case 'float':
      return { key, type: 'float', value: v.value };
    case 'int':
      return { key, type: 'int', value: BigInt(v.value) };
    case 'uint':
      return { key, type: 'uint', value: BigInt(v.value) };
    case 'string':
      return { key, type: 'string', value: v.value };
    case 'bool':
      return { key, type: 'bool', value: v.value };
  }
}

function formatValue(f: Field): string {
  switch (f.type) {
    case 'float':
      if (!Number.isFinite(f.value)) throw new EncodeError(`invalid float value for field ${quoteString(f.key)}: not finite`);
      return formatFloat(f.value);
    case 'int':
      if (f.value > MAX_INT64 || f.value < MIN_INT64) {
        throw new EncodeError(`int value for field ${quoteString(f.key)} out of range`);
      }
      return f.value.toString() + 'i';
    case 'uint':
      if (f.value > MAX_UINT64 || f.value < 0n) {
        throw new EncodeError(`uint value for field ${quoteString(f.key)} out of range`);
      }
      return f.value.toString() + 'u';
    case 'bool':
      return f.value ? 'true' : 'false';
    case 'string':
      if (!isWellFormed(f.value)) throw new EncodeError(`invalid utf-8 in value of field ${quoteString(f.key)}`);
      return '"' + escString(f.value) + '"';
  }
}

const PRECISION_NS: Record<Precision, bigint> = { ns: 1n, us: 1000n, µs: 1000n, ms: 1000000n, s: 1000000000n };

function toNanos(t: bigint | number | Date): bigint {
  if (t instanceof Date) return BigInt(t.getTime()) * 1000000n;
  if (typeof t === 'number') {
    if (!Number.isSafeInteger(t)) throw new EncodeError('timestamp must be a safe integer number of nanoseconds; use a bigint');
    return BigInt(t);
  }
  return t;
}

function encodeOne(p: PointInput, opts: EncodeOptions): string {
  if (!validMeasurement(p.measurement)) throw new EncodeError(`invalid measurement ${quoteString(p.measurement)}`);
  let out = escMeasurement(p.measurement);

  let tags: Tag[] = Array.isArray(p.tags) ? p.tags : p.tags ? Object.entries(p.tags).map(([key, value]) => ({ key, value })) : [];
  if (opts.sortTags !== false) tags = [...tags].sort((a, b) => compareUtf8(a.key, b.key));
  let prev: string | null = null;
  for (const t of tags) {
    if (!validMeasurementOrKey(t.key)) throw new EncodeError(`invalid tag key ${quoteString(t.key)}`);
    if (!validMeasurementOrKey(t.value)) throw new EncodeError(`invalid tag value ${t.key}=${quoteString(t.value)}`);
    if (prev !== null && compareUtf8(t.key, prev) <= 0) {
      throw new EncodeError(`tag key ${quoteString(t.key)} out of order (previous key ${quoteString(prev)})`);
    }
    prev = t.key;
    out += ',' + escKey(t.key) + '=' + escKey(t.value);
  }

  const fields: Field[] = Array.isArray(p.fields)
    ? p.fields
    : Object.entries(p.fields).map(([k, v]) => normalizeField(k, v));
  let sep = ' ';
  for (const f of fields) {
    const rendered = formatValue(f);
    if (!validMeasurementOrKey(f.key)) throw new EncodeError(`invalid field key ${quoteString(f.key)}`);
    out += sep + escKey(f.key) + '=' + rendered;
    sep = ',';
  }
  if (fields.length === 0) throw new EncodeError('timestamp must be added after adding at least one field');

  if (p.timestamp !== undefined && p.timestamp !== null) {
    const ns = toNanos(p.timestamp);
    if (ns > MAX_INT64 || ns < MIN_INT64) throw new EncodeError(`timestamp ${ns} ns: line-protocol value out of range`);
    const div = PRECISION_NS[opts.precision ?? 'ns'];
    out += ' ' + (ns / div).toString();
  }
  return out + '\n';
}

/**
 * Encodes one point or a list of points as line protocol. Every point ends
 * with a newline. Throws `EncodeError` for the first point that is invalid.
 */
export function encode(points: PointInput | Iterable<PointInput>, options: EncodeOptions = {}): string {
  if (typeof (points as { measurement?: unknown }).measurement === 'string') {
    return encodeOne(points as PointInput, options);
  }
  let out = '';
  let i = 0;
  for (const p of points as Iterable<PointInput>) {
    try {
      out += encodeOne(p, options);
    } catch (e) {
      if (i > 0 && e instanceof EncodeError) throw new EncodeError(`encoding point ${i}: ${e.message}`);
      throw e;
    }
    i++;
  }
  return out;
}
