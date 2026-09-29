# influx-line-protocol

An InfluxDB line protocol decoder and encoder for Node that accepts and rejects the same input as the reference Go implementation, `github.com/influxdata/line-protocol/v2`.

```ts
import { parse, encode } from 'influx-line-protocol';

const [p] = parse('cpu,host=a,region=us load=0.64,cores=8i,ok=t 1700000000000000000');
p.measurement; // 'cpu'
p.tags;        // [{ key: 'host', value: 'a' }, { key: 'region', value: 'us' }]
p.fields;      // [{ key: 'load', type: 'float', value: 0.64 }, { key: 'cores', type: 'int', value: 8n }, { key: 'ok', type: 'bool', value: true }]
p.timestamp;   // 1700000000000000000n
encode({ measurement: 'cpu', tags: { host: 'a' }, fields: { load: 0.64 } }); // 'cpu,host=a load=0.64\n'
```

## Why

Line protocol has escaping rules that differ per component, four numeric types that share one syntax, string fields that may contain raw newlines, and a decoder in the reference implementation that rejects a long list of malformed inputs. A parser that splits on spaces and commas gets valid lines wrong and accepts invalid ones without complaint.

- The Go library ships a corpus of 6,615 decode cases (395 valid, 6,220 that must be rejected). This package passes all of them.
- Errors carry the line and column and use the Go decoder's wording, so a bad line in a batch can be located and a `DecodeError` can be compared with the output of Telegraf or InfluxDB tooling.
- Integers are `bigint`, so `9223372036854775807i` and `18446744073709551615u` survive.
- The encoder produces output the Go decoder reads back unchanged.

`influx-line-protocol-parser` 0.2.0 was measured against the same corpus. `influxdb-line-protocol`, `@akayami/influxdb-line-protocol` and `@influxdata/influxdb-client` (encodes only) exist on npm and were not measured.

Measured: `node bench/corpus-compare.ts --incumbent <dir containing influx-line-protocol-parser@0.2.0>`

```
corpus: 6615 decode cases, 395 valid, 6220 must be rejected
influx-line-protocol (this package) valid 395/395 (100.0%)   rejected 6220/6220 (100.0%)
influx-line-protocol-parser 0.2.0  valid 180/395 (45.6%)   rejected    0/6220 (0.0%)
```

The incumbent never reports an error, has no field types and no precision option, so the script scores it generously: a valid input is correct when each line gives the expected measurement, tags, field values (numbers compared as numbers) and timestamp, and an input is rejected only if parsing throws or returns an empty result.

Measured: `node scripts/fuzz.ts --seed 1 --decode 200000 --encode 50000` (Go 1.27.1 oracle)

```
seed 1
decode: 200000/200000 inputs identical to the Go decoder (512266 entries: 141239 points and 371027 errors matched exactly, including line, column and message)
encode: 49885/49885 comparable points identical to the Go encoder (31059 accepted, 18826 rejected, plus 115 '#' measurements rejected on purpose)
round trip: 31059/31059 encoder outputs decoded back exactly by the Go decoder
```

Five seeds (1, 5, 6, 7, 8) gave the same result: 1,000,000 decode inputs and 250,000 encode points, no differences except the deliberate one described under Limitations.

## Installation

```sh
npm install influx-line-protocol
```

Node 20.6 or later. No runtime dependencies.

## Usage

### Decode a batch

`parse` returns every point and throws the `DecodeError` of the first bad line.

```ts
import { parse } from 'influx-line-protocol';

const points = parse(body, { precision: 'ms' });
```

`decode` is the lazy form. It yields points until the first bad line, then throws.

### Keep going after a bad line

`decodeEntries` reports each line as `{ ok: true, point }` or `{ ok: false, error }` and resumes on the next line, as the Go decoder does.

```ts
import { decodeEntries } from 'influx-line-protocol';

for (const entry of decodeEntries('a v=1\nb,x v=2\nc v=3\n')) {
  if (entry.ok) console.log(entry.point.measurement, entry.point.line);
  else console.log(entry.error.message);
}
// a 1
// at line 2:3: expected '=' after tag key "x", but got ' ' instead
// c 3
```

### Decode a stream

`decodeStream` and `decodeStreamEntries` take any async or sync iterable of strings or bytes (a Node `Readable`, a web `ReadableStream`, a `fetch` body). Entries can span chunks, including a string field with raw newlines and a multi-byte character split across chunks.

```ts
import { createReadStream } from 'node:fs';
import { decodeStream } from 'influx-line-protocol';

for await (const point of decodeStream(createReadStream('metrics.lp'))) {
  // ...
}
```

### Timestamps and precision

Timestamps are `bigint` nanoseconds since the epoch. `precision` (`'ns'`, `'us'`, `'ms'`, `'s'`) says what unit the input uses. A line without a timestamp gets `defaultTime` truncated to the precision, or `null` when no default is given.

```ts
parse('m v=1 5', { precision: 's' })[0].timestamp;                        // 5000000000n
parse('m v=1', { precision: 's', defaultTime: 1999999999n })[0].timestamp; // 1000000000n
```

### Encode

`encode` takes one point or a list and returns line protocol with a newline after each point. Tags are sorted by key (UTF-8 byte order). Fields can be typed or use shorthand values: `number` is a float, `bigint` an int, plus `string` and `boolean`.

```ts
encode({
  measurement: 'req',
  tags: { route: '/a b', method: 'GET' },
  fields: { ms: 12.5, n: 3n, ok: true, size: { type: 'uint', value: 512n } },
  timestamp: new Date('2026-01-01T00:00:00Z'),
});
// 'req,method=GET,route=/a\\ b ms=12.5,n=3i,ok=true,size=512u 1767225600000000000\n'
```

## Reference

### Functions

| Function | Returns | Description |
| --- | --- | --- |
| `parse(input, options?)` | `Point[]` | Decodes everything. Throws `DecodeError` on the first bad line. |
| `decode(input, options?)` | `Generator<Point>` | Lazy `parse`. |
| `decodeEntries(input, options?)` | `Generator<Entry>` | Yields points and errors, continuing after bad lines. |
| `decodeStream(source, options?)` | `AsyncGenerator<Point>` | Chunked input. Throws on the first bad line. |
| `decodeStreamEntries(source, options?)` | `AsyncGenerator<Entry>` | Chunked input, errors as entries. |
| `encode(points, options?)` | `string` | Encodes a `PointInput` or an iterable of them. Throws `EncodeError`. |
| `formatFloat(x)` | `string` | A float as the encoder writes it (Go's `strconv.FormatFloat(x, 'g', -1, 64)`). |

`input` is a string (encoded as UTF-8), a `Uint8Array`, another `ArrayBufferView` or an `ArrayBuffer`. Pass bytes to decode data that may contain invalid UTF-8, which is then rejected.

### Decode options

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `precision` | `'ns' \| 'us' \| 'µs' \| 'ms' \| 's'` | `'ns'` | Unit of the timestamps in the input. |
| `defaultTime` | `bigint \| Date` | none | Timestamp for lines without one (nanoseconds, or a `Date`), truncated to `precision`. Without it those points get `timestamp: null`. |

### Encode options

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `precision` | `'ns' \| 'us' \| 'µs' \| 'ms' \| 's'` | `'ns'` | Unit to write timestamps in. Values are truncated toward zero. |
| `sortTags` | `boolean` | `true` | Sort tags by key. When `false`, tags must already be in strictly increasing key order or encoding fails, as in the Go encoder. |

### Types

| Type | Shape |
| --- | --- |
| `Point` | `{ measurement: string; tags: Tag[]; fields: Field[]; timestamp: bigint \| null; line: number }` |
| `Tag` | `{ key: string; value: string }` |
| `Field` | `{ key: string }` plus one of `{ type: 'float'; value: number }`, `{ type: 'int'; value: bigint }`, `{ type: 'uint'; value: bigint }`, `{ type: 'string'; value: string }`, `{ type: 'bool'; value: boolean }` |
| `Entry` | `{ ok: true; point: Point } \| { ok: false; error: DecodeError }` |
| `PointInput` | `{ measurement; tags?: Tag[] \| Record<string, string>; fields: Field[] \| Record<string, FieldInput>; timestamp?: bigint \| number \| Date \| null }` |

`Point.line` is the one-based line where the entry starts. Tags keep the order in which they were written.

### Errors

| Class | Members |
| --- | --- |
| `DecodeError` | `line`, `column` (one-based, in bytes), `detail` (the Go message), `outOfRange` (well-formed but not representable), `message` (`at line L:C: detail`) |
| `EncodeError` | `message` |

## How it works

The decoder is a port of the Go decoder's section state machine (measurement, tags, fields, timestamp, and a recovery state that skips the rest of a bad line). It uses the same character sets and escape tables, so the same inputs are accepted and rejected, and the messages, lines and columns match. Some behavior comes straight from that design:

- Only the characters that a component needs to escape are unescaped. A backslash before anything else stays, so `a\\ b` is the measurement `a\ b`.
- Inside string fields `\"`, `\\`, `\n`, `\r` and `\t` are escapes and every other backslash stays. Raw newlines are allowed.
- A comment or blank line is skipped only when it is clean. A comment containing a control character is reported as an error.
- Number parsing follows Go's `strconv` (underscores in floats, hex floats, `-inf` as a distinct "non-number" error, range errors separate from syntax errors).
- Error text quotes tokens like Go's `%q`, including `\x` escapes for invalid bytes.

The differential tests run a small Go program (`scripts/oracle/`, its own `go.mod` pinned to `github.com/influxdata/line-protocol/v2` at commit `08518c8`) over generated and byte-mutated inputs, and compare every point and every error exactly. The encoder is compared byte for byte, and its output is fed back through the Go decoder.

Streaming keeps only the current entry in memory. When a read reaches the end of the buffered bytes, the entry is abandoned and decoded again once the next chunk arrives.

Files derived from the Go implementation (`src/decoder.ts`, `src/encoder.ts`) keep its copyright line in their headers. The Go library is MIT-licensed and its license is shipped verbatim in [LICENSE-line-protocol](LICENSE-line-protocol). The number parsing and `%q` quoting (`src/numparse.ts`, `src/quote.ts`) are adapted from Go's standard library `strconv`, whose BSD-style license is shipped verbatim in [LICENSE-go](LICENSE-go).

## Limitations

- Tag order and duplicate tag keys and field keys are not checked when decoding, because the Go decoder does not check them. InfluxDB itself may treat duplicates differently. The Go corpus harness sorts tags and rejects duplicate tag keys on its own, and the corpus test does the same.
- The reference is the Go source at commit `08518c8` (August 2022), which is newer than the last tag, `v2.2.1`. That tag words some errors differently and has a few differences in the decoder source. Agreement with `v2.2.1` was not measured.
- The encoder rejects a measurement that starts with `#`. The Go encoder accepts it, but writes a line that the Go decoder skips as a comment, so the point cannot be read back.
- The encoder does not accept `NaN` or infinite floats (the Go decoder rejects them too) and requires at least one field.
- A string passed to a decode function is encoded as UTF-8, so an unpaired surrogate becomes U+FFFD before decoding. Pass bytes to get invalid input rejected.
- Streaming re-decodes an entry from its start when more bytes arrive. An entry that spans many small chunks (a very large string field) costs quadratic time.
- Quoting of non-ASCII characters in error messages uses the Unicode tables of the running Node, and Go uses its own. All 1,112,027 code points tested matched with Node 24.20.0 and Go 1.27.1 (`node scripts/sweep-quote.ts`); other versions can differ for recently assigned characters.
- No lax mode, no InfluxDB v1 query-string handling, no gzip, and no `Point` builder API.

## Compatibility

Run: Node 24.20.0 on macOS (arm64) for the TypeScript suite, the built `dist/` smoke test and the Go comparison, with Go 1.27.1 for the oracle. `engines` says Node 20.6 or later. The `dist/` smoke test on Node 20 and 22 runs in the CI matrix and was not run locally.

## Development

```sh
npm install
npm run typecheck
npm test                       # TypeScript suite
npm run build && npm run test:dist
node scripts/fuzz.ts --seed 1  # more differential fuzzing (needs Go)
node scripts/capture-fixtures.ts   # regenerate the oracle-captured fixtures
```

`npm test` fetches the official corpus once from a pinned commit into `.cache/` (checked against a SHA-256, never committed) and skips with a message if it cannot. The Go comparison builds `scripts/oracle` and skips with a message when `go` is missing (set `GO=/path/to/go`).

## License

MIT. See [LICENSE](LICENSE). Portions are adapted from `github.com/influxdata/line-protocol` (Copyright (c) 2021 InfluxData Inc., MIT), see [LICENSE-line-protocol](LICENSE-line-protocol), and from the Go standard library (Copyright 2009 The Go Authors, BSD-style), see [LICENSE-go](LICENSE-go).
