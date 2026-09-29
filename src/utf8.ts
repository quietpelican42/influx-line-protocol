const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

/** Reports whether bytes are well-formed UTF-8 (same rules as Go's utf8.Valid). */
export function validUtf8(b: Uint8Array): boolean {
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b[i]!;
    if (c < 0x80) {
      i++;
      continue;
    }
    if (c < 0xc2) return false;
    if (c < 0xe0) {
      if (i + 1 >= n || (b[i + 1]! & 0xc0) !== 0x80) return false;
      i += 2;
      continue;
    }
    if (c < 0xf0) {
      if (i + 2 >= n) return false;
      const c1 = b[i + 1]!;
      const lo = c === 0xe0 ? 0xa0 : 0x80;
      const hi = c === 0xed ? 0x9f : 0xbf;
      if (c1 < lo || c1 > hi || (b[i + 2]! & 0xc0) !== 0x80) return false;
      i += 3;
      continue;
    }
    if (c < 0xf5) {
      if (i + 3 >= n) return false;
      const c1 = b[i + 1]!;
      const lo = c === 0xf0 ? 0x90 : 0x80;
      const hi = c === 0xf4 ? 0x8f : 0xbf;
      if (c1 < lo || c1 > hi || (b[i + 2]! & 0xc0) !== 0x80 || (b[i + 3]! & 0xc0) !== 0x80) return false;
      i += 4;
      continue;
    }
    return false;
  }
  return true;
}

/** Decodes bytes already known to be valid UTF-8. A leading BOM is kept. */
export function utf8ToString(b: Uint8Array): string {
  const n = b.length;
  if (n <= 24) {
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = b[i]!;
      if (c >= 0x80) return decoder.decode(b);
      s += String.fromCharCode(c);
    }
    return s;
  }
  return decoder.decode(b);
}

/** Bytes to a string with one char per byte (for ASCII-only parsing). */
export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** UTF-8 encodes a string. Lone surrogates become U+FFFD. */
export function stringToUtf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** True when the string has no unpaired surrogate. */
export function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Compares two strings by their UTF-8 bytes (equivalently, by code point). */
export function compareUtf8(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  const ra = a.length - i;
  const rb = b.length - j;
  return ra === rb ? 0 : ra < rb ? -1 : 1;
}
