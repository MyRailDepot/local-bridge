import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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

  it('is true for the real npm layout: the package lives one level below the install prefix', () => {
    // `npm install <pkg> --prefix <installDir>` places the package at
    // <installDir>/node_modules/@myraildepot/local-bridge, never at <installDir> itself — this is
    // the exact case that was silently broken before (equality-only check), verified against a
    // real `npm install --prefix` run during code review.
    const installDir = makeTempDir();
    const packageRoot = join(installDir, 'node_modules', '@myraildepot', 'local-bridge');
    // Actually create it (not just compute the string): on macOS, /var and /tmp are themselves
    // symlinks (-> /private/var, /private/tmp), and realpathSync only resolves a path that
    // exists — comparing a realpath'd installDir against a merely resolve()'d (non-realpath'd)
    // packageRoot would wrongly disagree on the prefix even though both name the same location.
    // In real usage this is a non-issue: by the time this function runs against the installed
    // copy, the package genuinely exists on disk (the code is running from inside it).
    mkdirSync(packageRoot, { recursive: true });
    assert.equal(isInstalledCopy(packageRoot, installDir), true);
  });

  it('is false for a sibling directory that merely shares a string prefix with installDir', () => {
    // Guards the containment check itself: a naive `startsWith(installDir)` would wrongly match
    // "<installDir>-other" (no path separator between them). Must require a real path boundary.
    const parent = makeTempDir();
    const installDir = join(parent, 'local-bridge');
    const sibling = join(parent, 'local-bridge-other', 'node_modules', '@myraildepot', 'local-bridge');
    assert.equal(isInstalledCopy(sibling, installDir), false);
  });
});
