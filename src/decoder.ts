/*
 * Port of the decoder in github.com/influxdata/line-protocol/v2/lineprotocol.
 *
 * Adapted from the Go source (decoder.go, value.go, escape.go, precision.go).
 * Copyright (c) 2021 InfluxData Inc. (MIT license, see LICENSE-line-protocol).
 *
 * The section state machine, the character sets, the escape handling, the error
 * messages and the recovery after a bad line all follow the Go code so the two
 * accept and reject the same inputs. Differences: the input is a byte array
 * held in memory, and for chunked input a read past the end of the buffered
 * data throws NEED_MORE so the caller can retry the entry with more bytes.
 */
import { DecodeError } from './errors.ts';
import { OK, parseFloat64, parseInt64, parseUint64, RANGE } from './numparse.ts';
import { latin1, utf8ToString, validUtf8 } from './utf8.ts';
import { quote, quoteByte } from './quote.ts';
import type { Field, Point, Precision } from './types.ts';

export const NEED_MORE = Symbol('need more input');

type ByteSet = Uint8Array;

function byteSet(chars: string): ByteSet {
  const s = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) s[chars.charCodeAt(i)] = 1;
  return s;
}
function range(set: ByteSet, lo: number, hi: number): ByteSet {
  for (let i = lo; i <= hi; i++) set[i] = 1;
  return set;
}
function union(a: ByteSet, b: ByteSet): ByteSet {
  const r = new Uint8Array(256);
  for (let i = 0; i < 256; i++) r[i] = a[i]! | b[i]!;
  return r;
}
function invert(a: ByteSet): ByteSet {
  const r = new Uint8Array(256);
  for (let i = 0; i < 256; i++) r[i] = a[i] ? 0 : 1;
  return r;
}
/** Reverse escape table: escaped char -> unescaped char (0 when not escapable). */
function escapes(chars: string): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    const c = chars.charCodeAt(i);
    // Go's escaper writes backslash + the char (or n, r, t for the whitespace ones).
    const esc = c === 0x0a ? 0x6e : c === 0x0d ? 0x72 : c === 0x09 ? 0x74 : c;
    t[esc] = c;
  }
  return t;
}

const whitespace = byteSet(' \r\n');
const nonPrintable = range(byteSet('\x7f'), 0, 31);
const tagKeyChars = invert(union(union(byteSet(',='), whitespace), nonPrintable));
const tagKeyEscapes = escapes(',= ');
const eolChars = byteSet('\r\n');
const measurementChars = invert(union(byteSet(', '), nonPrintable));
const measurementEscapes = escapes(' ,');
const tagValChars = tagKeyChars;
const tagValEscapes = escapes(', =');
const fieldKeyChars = tagKeyChars;
const fieldKeyEscapes = tagKeyEscapes;
const fieldStringValChars = invert(byteSet('"'));
const fieldStringValEscapes = escapes('\\"\n\r\t');
const fieldValChars = invert(union(byteSet(','), whitespace));
const timeChars = byteSet('-0123456789');
const commentChars = (() => {
  const s = invert(nonPrintable);
  for (let i = 0; i < 256; i++) if (eolChars[i]) s[i] = 0;
  return s;
})();
const notEOL = invert(eolChars);
const notNewline = invert(byteSet('\n'));

const MEASUREMENT = 0;
const TAG = 1;
const FIELD = 2;
const TIME = 3;
const NEWLINE = 4;
const END = 5;

export interface Snapshot {
  r0: number;
  r1: number;
  line: number;
  section: number;
}

const ONE_NS = { ns: 1n, us: 1000n, µs: 1000n, ms: 1000000n, s: 1000000000n } as const;

export function precisionNanos(p: Precision): bigint {
  return ONE_NS[p];
}

export class Decoder {
  buf: Uint8Array;
  /** Earliest read position that matters for column calculations. */
  r0 = 0;
  /** Read position. */
  r1 = 0;
  /** Whether buf holds all of the input. */
  complete: boolean;
  section = END;
  /** Line number of the byte at buf[r1]. */
  line = 1;

  constructor(buf: Uint8Array, complete: boolean) {
    this.buf = buf;
    this.complete = complete;
  }

  snapshot(): Snapshot {
    return { r0: this.r0, r1: this.r1, line: this.line, section: this.section };
  }

  restore(s: Snapshot): void {
    this.r0 = s.r0;
    this.r1 = s.r1;
    this.line = s.line;
    this.section = s.section;
  }

  /** Replaces the buffer with the unread tail plus more data (chunked input). */
  refill(more: Uint8Array): void {
    const rest = this.buf.subarray(this.r1);
    const nb = new Uint8Array(rest.length + more.length);
    nb.set(rest, 0);
    nb.set(more, rest.length);
    this.buf = nb;
    this.r0 = 0;
    this.r1 = 0;
  }

  // Low-level helpers -------------------------------------------------------

  private ensure(n: number): boolean {
    if (this.r1 + n <= this.buf.length) return true;
    if (this.complete) return false;
    throw NEED_MORE;
  }

  private at(i: number): number {
    const p = this.r1 + i;
    return p < this.buf.length ? this.buf[p]! : 0;
  }

  private take(set: ByteSet): Uint8Array {
    const buf = this.buf;
    const start = this.r1;
    let i = start;
    const n = buf.length;
    while (i < n && set[buf[i]!]) i++;
    if (i >= n && !this.complete) throw NEED_MORE;
    this.r1 = i;
    return buf.subarray(start, i);
  }

  private discardc(c: number): void {
    const buf = this.buf;
    let i = this.r1;
    const n = buf.length;
    while (i < n && buf[i] === c) i++;
    if (i >= n && !this.complete) throw NEED_MORE;
    this.r1 = i;
  }

  /** Like take, but backslash-escaped characters from the table also count. Returns [bytes, offset from r0]. */
  private takeEsc(set: ByteSet, revTable: Uint8Array): [Uint8Array, number] {
    const buf = this.buf;
    const n = buf.length;
    const startAbs = this.r1;
    const start = startAbs - this.r0;
    let i = startAbs;
    let segStart = startAbs;
    let parts: Uint8Array[] | null = null;
    let charBits = 0;
    for (;;) {
      if (i >= n) {
        if (!this.complete) throw NEED_MORE;
        break;
      }
      const c = buf[i]!;
      if (c !== 0x5c) {
        if (!set[c]) break;
        charBits |= c;
        i++;
        continue;
      }
      if (i + 1 >= n) {
        if (!this.complete) throw NEED_MORE;
        // No character to escape, so the backslash stays.
        i = n;
        break;
      }
      const rep = revTable[buf[i + 1]!]!;
      if (rep === 0) {
        i++;
        continue;
      }
      (parts ??= []).push(buf.subarray(segStart, i), Uint8Array.of(rep));
      segStart = i + 2;
      i += 2;
    }
    this.r1 = i;
    let taken: Uint8Array;
    if (parts) {
      parts.push(buf.subarray(segStart, i));
      let total = 0;
      for (const p of parts) total += p.length;
      taken = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        taken.set(p, o);
        o += p.length;
      }
    } else {
      taken = buf.subarray(startAbs, i);
    }
    if (set[0x0a]) {
      for (let k = startAbs; k < i; k++) if (buf[k] === 0x0a) this.line++;
    }
    if ((charBits & 0x80) !== 0 && !validUtf8(taken)) {
      throw this.syntaxError(start, `invalid utf-8 sequence in token ${quote(taken)}`);
    }
    return [taken, start];
  }

  private reset(): void {
    this.r0 = this.r1;
  }

  private takeEOL(): boolean {
    if (!this.ensure(1)) return true;
    switch (this.at(0)) {
      case 0x0a:
        this.r1++;
        this.line++;
        return true;
      case 0x0d:
        if (!this.ensure(2)) {
          this.r1++;
          return true;
        }
        if (this.at(1) === 0x0a) {
          this.r1 += 2;
          this.line++;
          return true;
        }
    }
    return false;
  }

  private syntaxError(offset: number, detail: string, outOfRange = false): DecodeError {
    const abs = this.r0 + offset;
    let lastNL = -1;
    for (let k = abs - 1; k >= this.r0; k--) {
      if (this.buf[k] === 0x0a) {
        lastNL = k;
        break;
      }
    }
    const column = lastNL >= 0 ? abs - lastNL : offset + 1;
    let remainNL = 0;
    for (let k = abs; k < this.r1; k++) if (this.buf[k] === 0x0a) remainNL++;
    const line = this.line - remainNL;
    if (this.section !== END) this.section = NEWLINE;
    return new DecodeError(line, column, detail, outOfRange);
  }

  // Section handling --------------------------------------------------------

  /** Advances to the next entry. False at end of input. */
  next(): boolean {
    try {
      this.advanceToSection(END);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      try {
        this.advanceToSection(END);
      } catch (e2) {
        if (!(e2 instanceof DecodeError)) throw e2;
      }
    }
    this.skipEmptyLines();
    this.section = MEASUREMENT;
    return this.ensure(1);
  }

  private skipEmptyLines(): void {
    for (;;) {
      const startLine = this.r1 - this.r0;
      this.discardc(0x20);
      switch (this.at(0)) {
        case 0x23:
          this.take(commentChars);
          if (!this.takeEOL()) {
            this.r1 = this.r0 + startLine;
            return;
          }
          break;
        case 0x0a:
          this.line++;
          this.r1++;
          break;
        case 0x0d:
          if (!this.takeEOL()) return;
          break;
        default:
          return;
      }
    }
  }

  private advanceToSection(section: number): boolean {
    if (this.section === section) return true;
    if (this.section > section) return false;
    while (this.section < section) this.consumeSection();
    return this.section === section;
  }

  private consumeSection(): void {
    switch (this.section) {
      case MEASUREMENT:
        this.measurementBytes();
        return;
      case TAG:
        while (this.nextTagBytes() !== null);
        return;
      case FIELD:
        while (this.nextFieldBytes() !== null);
        return;
      case TIME:
        this.timeBytes();
        return;
      case NEWLINE:
        this.consumeLine();
        return;
    }
  }

  private consumeLine(): void {
    this.take(notNewline);
    if (this.at(0) === 0x0a) {
      this.r1++;
      this.line++;
    }
    this.reset();
    this.section = END;
  }

  // Sections ----------------------------------------------------------------

  private measurementBytes(): Uint8Array | null {
    if (!this.advanceToSection(MEASUREMENT)) return null;
    this.reset();
    const [measure, i0] = this.takeEsc(measurementChars, measurementEscapes);
    if (measure.length === 0) {
      if (!this.ensure(1)) throw this.syntaxError(i0, 'no measurement name found');
      throw this.syntaxError(i0, `invalid character ${quoteByte(this.at(0))} found at start of measurement name`);
    }
    if (measure[0] === 0x23) throw this.syntaxError(i0, 'invalid character found in comment line');
    this.advanceTagComma();
    this.section = TAG;
    return measure;
  }

  private advanceTagComma(): void {
    if (!this.ensure(1)) return;
    if (this.at(0) !== 0x2c) return;
    this.r1++;
    if (!this.ensure(1)) throw this.syntaxError(this.r1 - this.r0, 'expected tag key after comma; got end of input');
    if (whitespace[this.at(0)]) {
      throw this.syntaxError(this.r1 - this.r0, 'expected tag key after comma; got white space instead');
    }
  }

  private nextTagBytes(): [Uint8Array, Uint8Array] | null {
    if (!this.advanceToSection(TAG)) return null;
    if (this.ensure(1) && this.at(0) === 0x20) {
      this.discardc(0x20);
      this.section = FIELD;
      return null;
    }
    const [tagKey, i0] = this.takeEsc(tagKeyChars, tagKeyEscapes);
    if (tagKey.length === 0 || !this.ensure(1) || this.at(0) !== 0x3d) {
      const hasKey = tagKey.length !== 0;
      const eof = !this.ensure(1);
      const hasEquals = !eof && this.at(0) === 0x3d;
      if (eof && !hasKey) throw this.syntaxError(i0, 'expected tag key or field but found end of input instead');
      if (eof) throw this.syntaxError(i0, `expected '=' after tag key ${quote(tagKey)}, but got end of input instead`);
      if (hasKey) {
        throw this.syntaxError(i0, `expected '=' after tag key ${quote(tagKey)}, but got ${quoteByte(this.at(0))} instead`);
      }
      if (hasEquals) throw this.syntaxError(i0, 'empty tag key');
      throw this.syntaxError(i0, `expected tag key or field but found ${quoteByte(this.at(0))} instead`);
    }
    this.r1++;
    const [tagVal, i1] = this.takeEsc(tagValChars, tagValEscapes);
    if (tagVal.length === 0) {
      throw this.syntaxError(i1, `expected tag value after tag key ${quote(tagKey)}, but none found`);
    }
    if (!this.ensure(1)) {
      this.section = FIELD;
      return [tagKey, tagVal];
    }
    this.advanceTagComma();
    return [tagKey, tagVal];
  }

  private nextFieldBytes(): [Uint8Array, 'string' | 'int' | 'uint' | 'float' | 'bool', Uint8Array] | null {
    if (!this.advanceToSection(FIELD)) return null;
    const [fieldKey, i0] = this.takeEsc(fieldKeyChars, fieldKeyEscapes);
    if (fieldKey.length === 0) {
      if (!this.ensure(1)) throw this.syntaxError(i0, 'expected field key but none found');
      throw this.syntaxError(i0, `invalid character ${quoteByte(this.at(0))} found at start of field key`);
    }
    if (!this.ensure(1)) {
      throw this.syntaxError(this.r1 - this.r0, `want '=' after field key ${quote(fieldKey)}, found end of input`);
    }
    const eq = this.at(0);
    if (eq !== 0x3d) {
      throw this.syntaxError(this.r1 - this.r0, `want '=' after field key ${quote(fieldKey)}, found ${quoteByte(eq)}`);
    }
    this.r1++;
    if (!this.ensure(1)) {
      throw this.syntaxError(this.r1 - this.r0, `expected value for field ${quote(fieldKey)}, found end of input`);
    }
    let fieldVal: Uint8Array;
    let kind: 'string' | 'int' | 'uint' | 'float' | 'bool';
    const c = this.at(0);
    if (c === 0x22) {
      this.r1++;
      const [val, iv] = this.takeEsc(fieldStringValChars, fieldStringValEscapes);
      fieldVal = val;
      kind = 'string';
      if (!this.ensure(1)) {
        throw this.syntaxError(iv - 1, `expected closing quote for string field ${quote(fieldKey)}, found end of input`);
      }
      if (this.at(0) !== 0x22) throw this.syntaxError(iv - 1, 'unexpected string termination');
      this.r1++;
    } else if (c === 0x74 || c === 0x54 || c === 0x66 || c === 0x46) {
      fieldVal = this.take(fieldValChars);
      kind = 'bool';
    } else if ((c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e) {
      fieldVal = this.take(fieldValChars);
      const last = fieldVal[fieldVal.length - 1];
      if (last === 0x69) {
        fieldVal = fieldVal.subarray(0, fieldVal.length - 1);
        kind = 'int';
      } else if (last === 0x75) {
        fieldVal = fieldVal.subarray(0, fieldVal.length - 1);
        kind = 'uint';
      } else {
        kind = 'float';
      }
    } else if (c === 0x20 || c === 0x2c) {
      throw this.syntaxError(this.r1 - this.r0, `missing field value for field ${quote(fieldKey)}`);
    } else {
      const start = this.r1 - this.r0;
      const bad = this.take(fieldValChars);
      throw this.syntaxError(start, `value for field ${quote(fieldKey)} (${quote(bad)}) has unrecognized type`);
    }
    if (!this.ensure(1)) {
      this.section = END;
      return [fieldKey, kind, fieldVal];
    }
    const nextc = this.at(0);
    if (nextc === 0x2c) {
      this.r1++;
      return [fieldKey, kind, fieldVal];
    }
    if (!whitespace[nextc]) {
      throw this.syntaxError(this.r1 - this.r0, `unexpected character ${quoteByte(nextc)} after field ${quote(fieldKey)}`);
    }
    this.discardc(0x20);
    if (this.takeEOL()) {
      this.section = END;
      return [fieldKey, kind, fieldVal];
    }
    this.section = TIME;
    return [fieldKey, kind, fieldVal];
  }

  private timeBytes(): Uint8Array | null {
    if (!this.advanceToSection(TIME)) return null;
    const start = this.r1 - this.r0;
    let timeBytes: Uint8Array | null = this.take(timeChars);
    if (timeBytes.length === 0) {
      this.section = END;
      timeBytes = null;
    }
    if (!this.ensure(1)) {
      this.section = END;
      return timeBytes;
    }
    if (!whitespace[this.at(0)]) {
      this.take(notEOL);
      throw this.syntaxError(start, `invalid timestamp (${quote(this.buf.subarray(this.r0 + start, this.r1))})`);
    }
    this.discardc(0x20);
    if (!this.ensure(1)) {
      this.section = END;
      return timeBytes;
    }
    if (!this.takeEOL()) {
      const start2 = this.r1 - this.r0;
      const extra = this.take(notEOL);
      throw this.syntaxError(start2, `unexpected text after timestamp (${quote(extra)})`);
    }
    this.section = END;
    return timeBytes;
  }

  // Typed accessors ---------------------------------------------------------

  private nextField(): Field | null {
    if (!this.advanceToSection(FIELD)) return null;
    let startIndex = this.r1 - this.r0;
    const f = this.nextFieldBytes();
    if (f === null) return null;
    const [keyBytes, kind, data] = f;
    const key = utf8ToString(keyBytes);
    const fail = (msg: string, oor = false): DecodeError => {
      let escLen = keyBytes.length;
      for (const b of keyBytes) if (b === 0x2c || b === 0x3d || b === 0x20) escLen++;
      startIndex += escLen + 1;
      return this.syntaxError(startIndex, `cannot parse value for field key ${quote(keyBytes)}: ${msg}`, oor);
    };
    switch (kind) {
      case 'int': {
        const r = parseInt64(latin1(data));
        if (r.err === RANGE) throw fail('line-protocol value out of range', true);
        if (r.err !== OK) throw fail('invalid integer value syntax');
        return { key, type: 'int', value: r.value };
      }
      case 'uint': {
        const r = parseUint64(latin1(data));
        if (r.err === RANGE) throw fail('line-protocol value out of range', true);
        if (r.err !== OK) throw fail('invalid unsigned integer value syntax');
        return { key, type: 'uint', value: r.value };
      }
      case 'float': {
        const r = parseFloat64(latin1(data));
        if (r.err === RANGE) throw fail('line-protocol value out of range', true);
        if (r.err !== OK) throw fail('invalid float value syntax');
        if (!Number.isFinite(r.value)) {
          throw fail(`non-number ${quote(data)} cannot be represented as a line-protocol field value`);
        }
        return { key, type: 'float', value: r.value };
      }
      case 'bool': {
        const s = latin1(data);
        if (s === 't' || s === 'T' || s === 'true' || s === 'True' || s === 'TRUE') {
          return { key, type: 'bool', value: true };
        }
        if (s === 'f' || s === 'F' || s === 'false' || s === 'False' || s === 'FALSE') {
          return { key, type: 'bool', value: false };
        }
        throw fail(`invalid bool value ${quote(data)}`);
      }
      default:
        return { key, type: 'string', value: utf8ToString(data) };
    }
  }

  private time(precision: bigint, defaultTime: bigint | null): bigint | null {
    if (!this.advanceToSection(TIME)) return truncate(defaultTime, precision);
    const start = this.r1 - this.r0;
    const data = this.timeBytes();
    if (data === null) return truncate(defaultTime, precision);
    const r = parseInt64(latin1(data));
    const shown = quote(data);
    if (r.err !== OK) {
      const oor = r.err === RANGE;
      throw this.syntaxError(
        start,
        `invalid timestamp (${shown}): ${oor ? 'line-protocol value out of range' : 'invalid syntax'}`,
        oor,
      );
    }
    const ns = r.value * precision;
    if (ns > 0x7fffffffffffffffn || ns < -0x8000000000000000n) {
      throw this.syntaxError(start, `invalid timestamp (${shown}): line-protocol value out of range`, true);
    }
    return ns;
  }

  /** Reads the rest of the current entry as a point. Throws DecodeError on a bad entry. */
  readPoint(precision: bigint, defaultTime: bigint | null): Point {
    const line = this.line;
    const m = this.measurementBytes();
    const measurement = utf8ToString(m!);
    const tags: { key: string; value: string }[] = [];
    for (;;) {
      const t = this.nextTagBytes();
      if (t === null) break;
      tags.push({ key: utf8ToString(t[0]), value: utf8ToString(t[1]) });
    }
    const fields: Field[] = [];
    for (;;) {
      const f = this.nextField();
      if (f === null) break;
      fields.push(f);
    }
    const timestamp = this.time(precision, defaultTime);
    return { measurement, tags, fields, timestamp, line };
  }
}

/** Floors ns to a multiple of the precision, like Go's time.Truncate on epoch-aligned units. */
function truncate(ns: bigint | null, precision: bigint): bigint | null {
  if (ns === null) return null;
  let q = ns / precision;
  if (ns % precision < 0n) q -= 1n;
  return q * precision;
}
