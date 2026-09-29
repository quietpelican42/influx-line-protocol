import type { DecodeError } from './errors.ts';

/** A tag key/value pair. */
export interface Tag {
  key: string;
  value: string;
}

/** A typed field value. `int` and `uint` are `bigint` so 64-bit values stay exact. */
export type FieldValue =
  | { type: 'float'; value: number }
  | { type: 'int'; value: bigint }
  | { type: 'uint'; value: bigint }
  | { type: 'string'; value: string }
  | { type: 'bool'; value: boolean };

/** A field: a key plus a typed value. */
export type Field = { key: string } & FieldValue;

/** One decoded line-protocol entry. */
export interface Point {
  measurement: string;
  /** Tags in the order they appear on the line. Order and duplicates are not checked. */
  tags: Tag[];
  fields: Field[];
  /** Nanoseconds since the Unix epoch, or `null` when the line has no timestamp and no default was given. */
  timestamp: bigint | null;
  /** One-based line number where the entry starts. */
  line: number;
}

export type Precision = 'ns' | 'us' | 'µs' | 'ms' | 's';

export interface DecodeOptions {
  /** Unit of timestamps on the wire. Default `'ns'`. */
  precision?: Precision;
  /**
   * Timestamp for lines that have none, in nanoseconds (a `bigint`), or a `Date`.
   * It is truncated to `precision`, as the Go decoder does. Without it such
   * points get `timestamp: null`.
   */
  defaultTime?: bigint | Date;
}

/** Result of decoding one entry when errors are reported instead of thrown. */
export type Entry = { ok: true; point: Point } | { ok: false; error: DecodeError };
