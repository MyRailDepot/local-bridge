import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getInstallDir, isInstalledCopy } from './paths.ts';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-bridge-paths-test-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('getInstallDir', () => {
  it('builds ~/.myraildepot/local-bridge under the given home directory', () => {
    assert.equal(getInstallDir('/Users/nico'), '/Users/nico/.myraildepot/local-bridge');
  });

  it('defaults to the real home directory when none is given', () => {
    const result = getInstallDir();
    assert.match(result, /\.myraildepot[/\\]local-bridge$/);
  });
});

describe('isInstalledCopy', () => {
  it('is true when the current package root is exactly the install dir', () => {
    const dir = makeTempDir();
    assert.equal(isInstalledCopy(dir, dir), true);
  });

  it('is false when they are different directories', () => {
    const a = makeTempDir();
    const b = makeTempDir();
    assert.equal(isInstalledCopy(a, b), false);
  });

  it('is false when the install dir does not exist yet (first ephemeral run)', () => {
    const current = makeTempDir();
    const installDir = join(current, 'does-not-exist-yet', '.myraildepot', 'local-bridge');
    assert.equal(isInstalledCopy(current, installDir), false);
  });

  it('sees through a symlink on the current-package-root side', () => {
    const real = makeTempDir();
    const linkParent = makeTempDir();
    const link = join(linkParent, 'link-to-real');
    symlinkSync(real, link);
    assert.equal(isInstalledCopy(link, real), true);
  });
});
