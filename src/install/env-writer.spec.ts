import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeInstallEnv } from './env-writer.ts';

const tempDirs: string[] = [];
function makeInstallDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-bridge-env-writer-test-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('writeInstallEnv', () => {
  it('writes BRIDGE_ID and BRIDGE_API_KEY to .env in the given directory', () => {
    const dir = makeInstallDir();
    writeInstallEnv(dir, { bridgeId: 'bridge-1', apiKey: 'key-1' });
    const content = readFileSync(join(dir, '.env'), 'utf8');
    assert.equal(content, 'BRIDGE_ID=bridge-1\nBRIDGE_API_KEY=key-1\n');
  });

  it('writes the file with 0o600 permissions (owner read/write only)', () => {
    const dir = makeInstallDir();
    writeInstallEnv(dir, { bridgeId: 'bridge-1', apiKey: 'key-1' });
    const mode = statSync(join(dir, '.env')).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('overwrites an existing .env rather than appending to it', () => {
    const dir = makeInstallDir();
    writeInstallEnv(dir, { bridgeId: 'old', apiKey: 'old-key' });
    writeInstallEnv(dir, { bridgeId: 'new', apiKey: 'new-key' });
    const content = readFileSync(join(dir, '.env'), 'utf8');
    assert.equal(content, 'BRIDGE_ID=new\nBRIDGE_API_KEY=new-key\n');
  });
});
