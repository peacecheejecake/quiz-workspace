// Unit tests for scripts/e2e-artifact-audit.ts (`node --test scripts/`; part of `make test`).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { audit, DIGEST_FILE } from './e2e-artifact-audit.ts';

function digestLine(secret: string): string {
  return `${secret.length} ${createHash('sha256').update(secret).digest('hex')}\n`;
}

/** Minimal single-entry deflated zip (local header + central directory + end record). */
function zip(name: string, content: string): Buffer {
  const data = deflateRawSync(Buffer.from(content));
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
}

function setup(): { root: string; results: string; testDir: string; secret: string } {
  const root = mkdtempSync(join(tmpdir(), 'artifact-audit-test-'));
  const results = join(root, 'test-results');
  const testDir = join(results, 'share-public-guest');
  mkdirSync(testDir, { recursive: true });
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(join(testDir, DIGEST_FILE), digestLine(secret));
  return { root, results, testDir, secret };
}

describe('e2e artifact audit', () => {
  it('passes clean artifacts and never prints the secret', () => {
    const { results, testDir, secret } = setup();
    writeFileSync(join(testDir, 'error-context.md'), 'Error: expected true, got false\n');
    const { findings, secrets } = audit([results]);
    assert.equal(secrets, 1);
    assert.deepEqual(findings, []);
    assert.ok(!JSON.stringify(findings).includes(secret));
  });

  it('finds a known secret in plain text, inside a longer token and in a zipped trace', () => {
    const { results, testDir, secret } = setup();
    writeFileSync(join(testDir, 'error-context.md'), `value: "xx${secret}yy"\n`);
    mkdirSync(join(results, 'other'));
    writeFileSync(join(results, 'other', 'data.zip'), zip('trace.trace', `{"s":"${secret}"}`));
    const kinds = audit([results]).findings.map((f) => f.kind);
    assert.deepEqual(kinds, ['known share secret', 'known share secret']);
  });

  it('finds share fragments, report-embedded zips and visual artifacts of secret tests', () => {
    const { root, results, testDir, secret } = setup();
    writeFileSync(join(testDir, 'test-failed-1.png'), 'png');
    const report = join(root, 'playwright-report');
    mkdirSync(report);
    const embedded = zip('report.json', `{"title":"Navigate to /share/x#k=${secret}"}`);
    writeFileSync(
      join(report, 'index.html'),
      `<script>window.r="data:application/zip;base64,${embedded.toString('base64')}"</script>`,
    );
    const kinds = audit([results, report])
      .findings.map((f) => f.kind)
      .sort();
    assert.deepEqual(kinds, [
      'known share secret',
      'share fragment #k=',
      'visual artifact of a test that handled a share secret',
    ]);
  });
});
