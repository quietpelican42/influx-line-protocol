export interface DecodeInput {
  name: string;
  text?: string;
  hex?: string;
  precision: 'ns' | 'us' | 'ms' | 's';
  defaultTime: string;
}

export interface EncodeInput {
  name: string;
  precision: 'ns' | 'us' | 'ms' | 's';
  point: { name: string; tags: [string, string][]; fields: [string, string, string][]; ts: string | null };
}

export function fixtureBytes(c: DecodeInput): Uint8Array {
  return c.hex !== undefined ? new Uint8Array(Buffer.from(c.hex, 'hex')) : new TextEncoder().encode(c.text!);
}
