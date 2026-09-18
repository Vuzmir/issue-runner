import { describe, expect, it } from 'vitest';

import { buildFor, platformKey, type Manifest } from './install.js';

describe('platformKey', () => {
  it('uses the strings Node already reports, which are the manifest keys', () => {
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('linux', 'x64')).toBe('linux-x64');
  });

  it('asks for the musl build only on linux', () => {
    expect(platformKey('linux', 'x64', true)).toBe('linux-x64-musl');
    expect(platformKey('linux', 'arm64', true)).toBe('linux-arm64-musl');
    // The flag comes from looking for a file, so it must not leak onto a platform where
    // that question is meaningless.
    expect(platformKey('darwin', 'arm64', true)).toBe('darwin-arm64');
    expect(platformKey('win32', 'x64', true)).toBe('win32-x64');
  });

  it('refuses a platform there is no build for, rather than 404ing later', () => {
    expect(() => platformKey('linux', 'ia32')).toThrow(/no build for linux-ia32/);
    expect(() => platformKey('freebsd', 'x64')).toThrow(/no build for freebsd-x64/);
  });
});

describe('buildFor', () => {
  const checksum = 'a'.repeat(64);
  const manifest: Manifest = { platforms: { 'win32-x64': { binary: 'claude.exe', checksum } } };

  it('returns the build for this platform', () => {
    expect(buildFor(manifest, 'win32-x64')).toEqual({ binary: 'claude.exe', checksum });
  });

  it('says which build was missing', () => {
    expect(() => buildFor(manifest, 'linux-arm64')).toThrow(/no linux-arm64 build/);
    expect(() => buildFor({}, 'win32-x64')).toThrow(/no win32-x64 build/);
  });

  it('refuses a checksum it cannot verify against', () => {
    // The case that matters: without this, a manifest with an empty checksum would be
    // compared against the download and silently "match" nothing.
    for (const bad of ['', 'nope', 'A'.repeat(64), 'a'.repeat(63)]) {
      const broken: Manifest = { platforms: { 'win32-x64': { binary: 'claude.exe', checksum: bad } } };
      expect(() => buildFor(broken, 'win32-x64')).toThrow(/no usable checksum/);
    }
  });

  it('refuses a build that names no binary, which would download the directory', () => {
    const broken: Manifest = { platforms: { 'win32-x64': { binary: '', checksum } } };
    expect(() => buildFor(broken, 'win32-x64')).toThrow(/names no binary/);
  });
});
