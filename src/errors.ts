/**
 * A syntax or value error found while decoding line protocol. Messages,
 * line numbers and columns follow the Go decoder (github.com/influxdata/line-protocol).
 */
export class DecodeError extends Error {
  /** One-based line of the offending byte. */
  readonly line: number;
  /** One-based column, counted in bytes. */
  readonly column: number;
  /** The message without the `at line L:C:` prefix. */
  readonly detail: string;
  /** True when the value was well-formed but outside the representable range. */
  readonly outOfRange: boolean;

  constructor(line: number, column: number, detail: string, outOfRange = false) {
    super(`at line ${line}:${column}: ${detail}`);
    this.name = 'DecodeError';
    this.line = line;
    this.column = column;
    this.detail = detail;
    this.outOfRange = outOfRange;
  }
}

/** A point that cannot be encoded as line protocol. */
export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodeError';
  }
}
