import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const oracleDir = join(root, 'scripts', 'oracle');
const binary = join(root, '.cache', 'oracle');

function findGo(): string | null {
  const candidates = [process.env.GO, 'go', '/opt/homebrew/bin/go', '/usr/local/go/bin/go'].filter((x): x is string => !!x);
  for (const c of candidates) {
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

export type OracleResult = { path: string; version: string } | { skip: string };

/** Builds the Go oracle into .cache/, or explains why it cannot. */
export function buildOracle(): OracleResult {
  const go = findGo();
  if (!go) return { skip: 'go was not found (set GO=/path/to/go); differential tests need it' };
  mkdirSync(dirname(binary), { recursive: true });
  const r = spawnSync(go, ['build', '-o', binary, '.'], { cwd: oracleDir, encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(binary)) {
    return { skip: `could not build scripts/oracle (needs network for the first module download): ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` };
  }
  const v = spawnSync(go, ['version'], { encoding: 'utf8' }).stdout.trim();
  return { path: binary, version: v };
}

/** Runs requests through the oracle, one JSON line in and one out per request. */
export function runOracle(path: string, requests: unknown[]): any[] {
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const r = spawnSync(path, [], { input, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`oracle exited ${r.status}: ${r.stderr.slice(0, 500)}`);
  const lines = r.stdout.split('\n').filter((l) => l !== '');
  if (lines.length !== requests.length) throw new Error(`oracle returned ${lines.length} results for ${requests.length} requests`);
  return lines.map((l) => JSON.parse(l));
}
