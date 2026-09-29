/*
 * Adapted from the Go standard library, package strconv (atof.go, atoi.go).
 * Copyright 2009 The Go Authors. BSD-style license, see LICENSE-go.
 */
/**
 * Number parsing with Go's strconv semantics (ParseInt, ParseUint, ParseFloat
 * for base 10 / bitSize 64), including which inputs are syntax errors and
 * which are range errors. Inputs are strings with one char per byte.
 */

export const OK = 0;
export const SYNTAX = 1;
export const RANGE = 2;

export interface Parsed<T> {
  err: 0 | 1 | 2;
  value: T;
}

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_INT64 = (1n << 63n) - 1n;
const MIN_INT64 = -(1n << 63n);

function parseUintDigits(s: string): Parsed<bigint> {
  if (s === '') return { err: SYNTAX, value: 0n };
  let n = 0n;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return { err: SYNTAX, value: 0n };
    n = n * 10n + BigInt(c - 0x30);
    if (n > MAX_UINT64) return { err: RANGE, value: MAX_UINT64 };
  }
  return { err: OK, value: n };
}

/** strconv.ParseUint(s, 10, 64). */
export function parseUint64(s: string): Parsed<bigint> {
  return parseUintDigits(s);
}

/** strconv.ParseInt(s, 10, 64). */
export function parseInt64(s: string): Parsed<bigint> {
  if (s === '') return { err: SYNTAX, value: 0n };
  let neg = false;
  let rest = s;
  if (s[0] === '+') rest = s.slice(1);
  else if (s[0] === '-') {
    rest = s.slice(1);
    neg = true;
  }
  const r = parseUintDigits(rest);
  if (r.err === SYNTAX) return { err: SYNTAX, value: 0n };
  const un = r.value;
  const cutoff = 1n << 63n;
  if (!neg && un >= cutoff) return { err: RANGE, value: MAX_INT64 };
  if (neg && un > cutoff) return { err: RANGE, value: MIN_INT64 };
  return { err: OK, value: neg ? -un : un };
}

function lower(c: number): number {
  return c | 0x20;
}

function underscoreOK(str: string): boolean {
  let saw = '^';
  let i = 0;
  let s = str;
  if (s.length >= 1 && (s[0] === '-' || s[0] === '+')) s = s.slice(1);
  let hex = false;
  if (s.length >= 2 && s[0] === '0') {
    const l = lower(s.charCodeAt(1));
    if (l === 0x62 || l === 0x6f || l === 0x78) {
      i = 2;
      saw = '0';
      hex = l === 0x78;
    }
  }
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x30 && c <= 0x39) || (hex && lower(c) >= 0x61 && lower(c) <= 0x66)) {
      saw = '0';
      continue;
    }
    if (c === 0x5f) {
      if (saw !== '0') return false;
      saw = '_';
      continue;
    }
    if (saw === '_') return false;
    saw = '!';
  }
  return saw !== '_';
}

function commonPrefixLenIgnoreCase(s: string, prefix: string): number {
  const n = Math.min(prefix.length, s.length);
  for (let i = 0; i < n; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) c += 0x20;
    if (c !== prefix.charCodeAt(i)) return i;
  }
  return n;
}

/** Go's strconv special(): [value, consumed] for inf / infinity / nan, else null. */
function special(str: string): [number, number] | null {
  if (str.length === 0) return null;
  let s = str;
  let sign = 1;
  let nsign = 0;
  const c0 = s[0]!;
  if (c0 === '+' || c0 === '-') {
    if (c0 === '-') sign = -1;
    nsign = 1;
    s = s.slice(1);
  }
  if (nsign === 1 || c0 === 'i' || c0 === 'I') {
    let n = commonPrefixLenIgnoreCase(s, 'infinity');
    if (n > 3 && n < 8) n = 3;
    if (n === 3 || n === 8) return [sign * Infinity, nsign + n];
    return null;
  }
  if (c0 === 'n' || c0 === 'N') {
    if (commonPrefixLenIgnoreCase(s, 'nan') === 3) return [NaN, 3];
  }
  return null;
}

interface FloatSyntax {
  ok: boolean;
  end: number;
  hex: boolean;
  neg: boolean;
  mantissa: bigint;
  exp: number;
  trunc: boolean;
}

/** Port of strconv readFloat. The mantissa is only accumulated for hex floats. */
function readFloat(s: string): FloatSyntax {
  const res: FloatSyntax = { ok: false, end: 0, hex: false, neg: false, mantissa: 0n, exp: 0, trunc: false };
  let i = 0;
  if (i >= s.length) return res;
  let underscores = false;
  if (s[i] === '+') i++;
  else if (s[i] === '-') {
    i++;
    res.neg = true;
  }
  let base = 10;
  let maxMantDigits = 19;
  let expChar = 0x65;
  if (i + 2 < s.length && s[i] === '0' && lower(s.charCodeAt(i + 1)) === 0x78) {
    base = 16;
    maxMantDigits = 16;
    i += 2;
    expChar = 0x70;
    res.hex = true;
  }
  let sawdot = false;
  let sawdigits = false;
  let nd = 0;
  let ndMant = 0;
  let dp = 0;
  let mantissa = 0n;
  loop: for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5f) {
      underscores = true;
      continue;
    }
    if (c === 0x2e) {
      if (sawdot) break loop;
      sawdot = true;
      dp = nd;
      continue;
    }
    if (c >= 0x30 && c <= 0x39) {
      sawdigits = true;
      if (c === 0x30 && nd === 0) {
        dp--;
        continue;
      }
      nd++;
      if (ndMant < maxMantDigits) {
        if (base === 16) mantissa = mantissa * 16n + BigInt(c - 0x30);
        ndMant++;
      } else if (c !== 0x30) {
        res.trunc = true;
      }
      continue;
    }
    if (base === 16 && lower(c) >= 0x61 && lower(c) <= 0x66) {
      sawdigits = true;
      nd++;
      if (ndMant < maxMantDigits) {
        mantissa = mantissa * 16n + BigInt(lower(c) - 0x61 + 10);
        ndMant++;
      } else {
        res.trunc = true;
      }
      continue;
    }
    break;
  }
  if (!sawdigits) return res;
  if (!sawdot) dp = nd;
  if (base === 16) {
    dp *= 4;
    ndMant *= 4;
  }
  if (i < s.length && lower(s.charCodeAt(i)) === expChar) {
    i++;
    if (i >= s.length) return res;
    let esign = 1;
    if (s[i] === '+') i++;
    else if (s[i] === '-') {
      i++;
      esign = -1;
    }
    if (i >= s.length || s.charCodeAt(i) < 0x30 || s.charCodeAt(i) > 0x39) return res;
    let e = 0;
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x5f) {
        underscores = true;
        continue;
      }
      if (c < 0x30 || c > 0x39) break;
      if (e < 10000) e = e * 10 + (c - 0x30);
    }
    dp += e * esign;
  } else if (base === 16) {
    return res;
  }
  if (mantissa !== 0n) res.exp = dp - ndMant;
  res.mantissa = mantissa;
  if (underscores && !underscoreOK(s.slice(0, i))) return res;
  res.ok = true;
  res.end = i;
  return res;
}

const f64 = new DataView(new ArrayBuffer(8));

/** Port of strconv atofHex for float64. */
function atofHex(mantissaIn: bigint, expIn: number, neg: boolean, trunc: boolean): Parsed<number> {
  const mantbits = 52n;
  const expbits = 11;
  const bias = -1023;
  const maxExp = (1 << expbits) + bias - 2;
  const minExp = bias + 1;
  let mantissa = mantissaIn;
  let exp = expIn + Number(mantbits);
  while (mantissa !== 0n && mantissa >> (mantbits + 2n) === 0n) {
    mantissa <<= 1n;
    exp--;
  }
  if (trunc) mantissa |= 1n;
  while (mantissa >> (1n + mantbits + 2n) !== 0n) {
    mantissa = (mantissa >> 1n) | (mantissa & 1n);
    exp++;
  }
  while (mantissa > 1n && exp < minExp - 2) {
    mantissa = (mantissa >> 1n) | (mantissa & 1n);
    exp++;
  }
  let round = mantissa & 3n;
  mantissa >>= 2n;
  round |= mantissa & 1n;
  exp += 2;
  if (round === 3n) {
    mantissa++;
    if (mantissa === 1n << (1n + mantbits)) {
      mantissa >>= 1n;
      exp++;
    }
  }
  if (mantissa >> mantbits === 0n) exp = bias;
  let err: 0 | 2 = OK;
  if (exp > maxExp) {
    mantissa = 1n << mantbits;
    exp = maxExp + 1;
    err = RANGE;
  }
  let bits = mantissa & ((1n << mantbits) - 1n);
  bits |= BigInt((exp - bias) & ((1 << expbits) - 1)) << mantbits;
  if (neg) bits |= 1n << 63n;
  f64.setBigUint64(0, bits);
  return { err, value: f64.getFloat64(0) };
}

/** strconv.ParseFloat(s, 64). */
export function parseFloat64(s: string): Parsed<number> {
  const sp = special(s);
  if (sp) {
    if (sp[1] !== s.length) return { err: SYNTAX, value: 0 };
    return { err: OK, value: sp[0] };
  }
  const r = readFloat(s);
  if (!r.ok || r.end !== s.length) return { err: SYNTAX, value: 0 };
  if (r.hex) return atofHex(r.mantissa, r.exp, r.neg, r.trunc);
  const v = Number(s.includes('_') ? s.replaceAll('_', '') : s);
  if (!Number.isFinite(v)) return { err: RANGE, value: v };
  return { err: OK, value: v };
}
