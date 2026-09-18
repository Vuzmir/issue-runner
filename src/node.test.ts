import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('./install.js', () => ({ musl: vi.fn(() => false) }));

import { musl } from './install.js';
import { assetFor, checksumFor, resolveNodeVersion } from './node.js';

describe('assetFor', () => {
  it('names the official tarball for each platform, using Node\'s own strings', () => {
    expect(assetFor('linux', 'x64', '22.12.0').archive).toBe('node-v22.12.0-linux-x64.tar.gz');
    expect(assetFor('darwin', 'arm64', '22.12.0').archive).toBe('node-v22.12.0-darwin-arm64.tar.gz');
    expect(assetFor('win32', 'x64', '22.12.0').archive).toBe('node-v22.12.0-win-x64.zip');
  });

  it('points at where node/node.exe actually lands once extracted', () => {
    expect(assetFor('linux', 'x64', '22.12.0').binDir('/cache/root')).toBe(path.join('/cache/root', 'bin'));
    // The Windows archive's own top-level directory *is* the bin dir - there is no nested one.
    expect(assetFor('win32', 'x64', '22.12.0').binDir('/cache/root')).toBe('/cache/root');
  });

  it('refuses an architecture Node.js does not build for', () => {
    expect(() => assetFor('linux', 'ia32', '22.12.0')).toThrow(/no build for linux-ia32/);
  });

  it('refuses a musl runner before it downloads a glibc binary that cannot run there', () => {
    vi.mocked(musl).mockReturnValueOnce(true);
    expect(() => assetFor('linux', 'x64', '22.12.0')).toThrow(/no official musl build/);
  });
});

describe('checksumFor', () => {
  const shasums = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v22.12.0-linux-x64.tar.gz',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  node-v22.12.0-win-x64.zip',
  ].join('\n');

  it('finds the checksum for the exact archive name', () => {
    expect(checksumFor(shasums, 'node-v22.12.0-win-x64.zip')).toBe('b'.repeat(64));
  });

  it('says which archive was missing, rather than returning another one\'s checksum', () => {
    expect(() => checksumFor(shasums, 'node-v22.12.0-darwin-arm64.tar.gz')).toThrow(/no entry for node-v22\.12\.0-darwin-arm64\.tar\.gz/);
  });

  it('refuses a line whose checksum column is not a checksum', () => {
    const broken = 'not-a-checksum  node-v22.12.0-linux-x64.tar.gz';
    expect(() => checksumFor(broken, 'node-v22.12.0-linux-x64.tar.gz')).toThrow(/no usable checksum/);
  });
});

describe('resolveNodeVersion', () => {
  it('passes an exact version through without asking the release index', async () => {
    expect(await resolveNodeVersion('22.12.0')).toBe('22.12.0');
  });

  it('refuses anything that is neither a version nor a known channel', async () => {
    await expect(resolveNodeVersion('stable')).rejects.toThrow(/not 'lts' or 'latest'/);
  });
});
