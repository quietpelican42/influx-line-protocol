/*
 * Adapted from the Go standard library, package strconv (quote.go, isprint.go).
 * Copyright 2009 The Go Authors. BSD-style license, see LICENSE-go.
 */
/**
 * Go-compatible quoting (strconv.Quote and strconv.QuoteRune), used so error
 * messages read exactly like the Go decoder's `%q` output.
 */

const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

function isPrint(r: number): boolean {
  if (r <= 0xff) {
    if (r >= 0x20 && r < 0x7f) return true;
    return r >= 0xa1 && r !== 0xad;
  }
  return PRINTABLE.test(String.fromCodePoint(r));
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0');
}

function escapedRune(r: number, quote: string): string {
  const ch = r < 0x110000 && !(r >= 0xd800 && r < 0xe000) ? String.fromCodePoint(r) : '';
  if (ch === quote || ch === '\\') return '\\' + ch;
  if (ch !== '' && isPrint(r)) return ch;
  switch (r) {
    case 7:
      return '\\a';
    case 8:
      return '\\b';
    case 12:
      return '\\f';
    case 10:
      return '\\n';
    case 13:
      return '\\r';
    case 9:
      return '\\t';
    case 11:
      return '\\v';
  }
  if (r < 0x20 || r === 0x7f) return '\\x' + hex(r, 2);
  if (ch === '') r = 0xfffd;
  if (r < 0x10000) return '\\u' + hex(r, 4);
  return '\\U' + hex(r, 8);
}

/** Decodes one rune at b[i]. Invalid encodings give [0xFFFD, 1] as in Go. */
function decodeRune(b: Uint8Array, i: number): [number, number] {
  const c = b[i]!;
  if (c < 0x80) return [c, 1];
  const n = b.length;
  const cont = (k: number, lo = 0x80, hi = 0xbf): number => {
    if (i + k >= n) return -1;
    const x = b[i + k]!;
    return x >= lo && x <= hi ? x & 0x3f : -1;
  };
  if (c >= 0xc2 && c < 0xe0) {
    const a = cont(1);
    if (a < 0) return [0xfffd, 1];
    return [((c & 0x1f) << 6) | a, 2];
  }
  if (c >= 0xe0 && c < 0xf0) {
    const a = cont(1, c === 0xe0 ? 0xa0 : 0x80, c === 0xed ? 0x9f : 0xbf);
    const d = a < 0 ? -1 : cont(2);
    if (a < 0 || d < 0) return [0xfffd, 1];
    return [((c & 0x0f) << 12) | (a << 6) | d, 3];
  }
  if (c >= 0xf0 && c < 0xf5) {
    const a = cont(1, c === 0xf0 ? 0x90 : 0x80, c === 0xf4 ? 0x8f : 0xbf);
    const d = a < 0 ? -1 : cont(2);
    const e = d < 0 ? -1 : cont(3);
    if (a < 0 || d < 0 || e < 0) return [0xfffd, 1];
    return [((c & 0x07) << 18) | (a << 12) | (d << 6) | e, 4];
  }
  return [0xfffd, 1];
}

/** strconv.Quote applied to the bytes as a Go string. */
export function quote(b: Uint8Array): string {
  let out = '"';
  let i = 0;
  while (i < b.length) {
    const [r, w] = decodeRune(b, i);
    if (w === 1 && r === 0xfffd) {
      out += '\\x' + hex(b[i]!, 2);
      i++;
      continue;
    }
    out += escapedRune(r, '"');
    i += w;
  }
  return out + '"';
}

/** strconv.Quote of a JS string (encoded as UTF-8; lone surrogates print as U+FFFD escapes). */
export function quoteString(s: string): string {
  return quote(new TextEncoder().encode(s));
}

/** fmt's %q for a byte value: a single-quoted character literal. */
export function quoteByte(c: number): string {
  return "'" + escapedRune(c, "'") + "'";
}
