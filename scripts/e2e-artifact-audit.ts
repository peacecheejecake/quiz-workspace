// `pnpm e2e:artifact-audit [dir ...]` (default: test-results playwright-report)
//
// S0 (AGENTS.md §5: share secrets never in traces/artifacts): run right after the sharing specs
// (Playwright wipes test-results/ when it starts). The sharing fixture
// (tests/e2e/fixtures/sharing.ts) writes `<length> <sha256>` of every share secret a test saw to
// `share-secret.sha256` in that test's output dir (never the value). This script reads every
// artifact under the given directories — plain files, zip archives (Playwright traces) and the zip
// data the HTML report embeds as `data:application/zip;base64,…` — and fails when it finds
//   - a token containing a known secret (same length and SHA-256),
//   - a `#k=<value>` share fragment (also URL-encoded), or
//   - a trace, screenshot or video in the output dir of a test that handled a secret
//     (the sharing specs run with trace/screenshot/video off).
// Findings name the file and the kind, never the value. Runs on plain Node (type stripping).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const DIGEST_FILE = 'share-secret.sha256';
const DEFAULT_DIRS = ['test-results', 'playwright-report'];
const VISUAL = /(^trace\.zip$|\.png$|\.jpe?g$|\.webm$)/i;
const FRAGMENT = /(?:#|%23)k(?:=|%3D)[A-Za-z0-9_-]{16,}/i;
const TOKEN = /[A-Za-z0-9_-]{16,}/g;
const EMBEDDED_ZIP = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/g;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export interface Finding {
  readonly file: string;
  readonly kind: string;
}

/** Known secrets as SHA-256 digests grouped by secret length. */
export type Digests = Map<number, Set<string>>;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Adds the `<length> <sha256>` lines of a digest file to `into`. */
export function parseDigests(text: string, into: Digests = new Map()): Digests {
  for (const line of text.split('\n')) {
    const m = /^(\d+) ([0-9a-f]{64})$/.exec(line.trim());
    if (!m?.[1] || !m[2]) continue;
    const len = Number(m[1]);
    const set = into.get(len) ?? new Set<string>();
    set.add(m[2]);
    into.set(len, set);
  }
  return into;
}

/** True when a window of some token run has the length and digest of a known secret. */
export function containsKnownSecret(text: string, digests: Digests): boolean {
  if (!digests.size) return false;
  for (const run of text.match(TOKEN) ?? []) {
    for (const [len, set] of digests) {
      for (let i = 0; i + len <= run.length; i++) {
        if (set.has(sha256(run.slice(i, i + len)))) return true;
      }
    }
  }
  return false;
}

/** Entries of a zip archive (stored or deflated; no zip64). Unreadable entries are skipped. */
export function unzip(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    try {
      if (method === 0) out.push({ name, data: raw });
      else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    } catch {
      // corrupt entry: skipped
    }
  }
  return out;
}

/** Scans one blob, recursing into zip archives and zips embedded in the HTML report. */
export function scanBlob(file: string, data: Buffer, digests: Digests, depth = 0): Finding[] {
  const findings: Finding[] = [];
  if (depth > 3) return findings;
  if (data.length >= 4 && data.readUInt32LE(0) === 0x04034b50) {
    for (const entry of unzip(data)) {
      findings.push(...scanBlob(`${file}!${entry.name}`, entry.data, digests, depth + 1));
    }
    return findings;
  }
  const text = data.toString('utf8');
  if (FRAGMENT.test(text)) findings.push({ file, kind: 'share fragment #k=' });
  if (containsKnownSecret(text, digests)) findings.push({ file, kind: 'known share secret' });
  for (const m of text.matchAll(EMBEDDED_ZIP)) {
    const zip = Buffer.from(m[1] ?? '', 'base64');
    findings.push(...scanBlob(`${file}!embedded-zip`, zip, digests, depth + 1));
  }
  return findings;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export function audit(dirs: readonly string[]): { findings: Finding[]; secrets: number } {
  const files = dirs.flatMap(walk);
  const digestFiles = files.filter((f) => basename(f) === DIGEST_FILE);
  const digests: Digests = new Map();
  for (const f of digestFiles) parseDigests(readFileSync(f, 'utf8'), digests);
  const secretDirs = new Set(digestFiles.map((f) => dirname(f)));
  const findings: Finding[] = [];
  for (const file of files) {
    if (basename(file) === DIGEST_FILE) continue;
    if (VISUAL.test(basename(file)) && secretDirs.has(dirname(file))) {
      findings.push({ file, kind: 'visual artifact of a test that handled a share secret' });
    }
    if (statSync(file).size > MAX_FILE_BYTES) {
      findings.push({ file, kind: 'too large to scan' });
      continue;
    }
    findings.push(...scanBlob(file, readFileSync(file), digests));
  }
  const secrets = [...digests.values()].reduce((n, set) => n + set.size, 0);
  return { findings, secrets };
}

function main(argv: readonly string[]): number {
  const dirs = argv.length ? argv : DEFAULT_DIRS;
  const { findings, secrets } = audit(dirs);
  for (const f of findings) console.error(`e2e:artifact-audit: ${f.kind} in ${f.file}`);
  console.log(
    `e2e:artifact-audit: ${secrets} known share secret(s), ${findings.length} finding(s) in ` +
      dirs.join(', '),
  );
  return findings.length ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
