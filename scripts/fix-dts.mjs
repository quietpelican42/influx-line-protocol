// tsc keeps `.ts` in relative specifiers inside emitted .d.ts files, which
// consumers' TypeScript cannot resolve. Point them at the emitted `.js` instead.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../dist/', import.meta.url);
for (const name of readdirSync(dir)) {
  if (!name.endsWith('.d.ts')) continue;
  const file = new URL(name, dir);
  const src = readFileSync(file, 'utf8');
  const out = src.replace(/(from\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2');
  if (out !== src) writeFileSync(file, out);
}
