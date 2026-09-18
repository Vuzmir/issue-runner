// Getting the CLI onto the runner, rather than asking whoever set the runner up to have put
// it there.
//
// That request sounds small and is not. A self-hosted runner service usually runs as an
// account nobody logs into, which sees only the machine PATH and cannot read another user's
// home - so the obvious install, the per-user one, is invisible to it. Downloading the
// binary here sidesteps all of that, works the same on a hosted runner, and pins a version
// instead of inheriting whatever a machine happens to have.
//
// Anthropic's own installers are a shell script and a PowerShell script; neither is usable
// from an action that refuses to assume a shell. What they do, though, is simple enough to
// do directly, and the manifest keys are `${process.platform}-${process.arch}` - the exact
// strings Node already reports.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';

import { getText } from './http.js';

const RELEASES = 'https://downloads.claude.ai/claude-code-releases';
const TOOL = 'claude-code';

/** A release channel resolves to one of these; anything else is asked for by number. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

const SUPPORTED = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);

export interface PlatformBuild {
  /** `claude` or `claude.exe` - the file name and the last segment of the download URL. */
  binary: string;
  checksum: string;
}

export interface Manifest {
  platforms?: Record<string, PlatformBuild | undefined>;
}

/** musl builds are a separate download, and from Node the only way to tell is to look. */
export function musl(): boolean {
  return fs.existsSync('/lib/libc.musl-x86_64.so.1') || fs.existsSync('/lib/libc.musl-aarch64.so.1');
}

export function platformKey(platform: string, arch: string, isMusl = false): string {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.has(key)) throw new Error(`Claude Code has no build for ${key}.`);
  return platform === 'linux' && isMusl ? `${key}-musl` : key;
}

export function buildFor(manifest: Manifest, key: string): PlatformBuild {
  const build = manifest.platforms?.[key];
  if (build === undefined) throw new Error(`The release manifest lists no ${key} build.`);
  // A manifest that arrived but says nothing usable is the case worth catching: without this
  // the download would be verified against an empty string and pass.
  if (!CHECKSUM_PATTERN.test(build.checksum)) throw new Error(`The ${key} build carries no usable checksum.`);
  if (build.binary === '') throw new Error(`The ${key} build names no binary.`);
  return build;
}

export async function resolveVersion(requested: string): Promise<string> {
  if (VERSION_PATTERN.test(requested)) return requested;
  const named = (await getText(`${RELEASES}/${requested}`)).trim();
  // An unreachable or region-blocked download service answers with a page, not a version.
  // Catching that here keeps it from becoming a confusing 404 on the manifest URL.
  if (!VERSION_PATTERN.test(named)) throw new Error(`The '${requested}' channel did not name a version.`);
  return named;
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** The CLI, downloaded if this runner has not already cached that version. */
export async function install(requested: string): Promise<string> {
  const version = await resolveVersion(requested);
  const key = platformKey(process.platform, process.arch, musl());

  const cached = tc.find(TOOL, version, key);
  if (cached !== '') {
    const binary = fs.readdirSync(cached)[0] ?? '';
    core.info(`Claude Code ${version} (${key}) is already cached on this runner.`);
    return path.join(cached, binary);
  }

  const manifest = JSON.parse(await getText(`${RELEASES}/${version}/manifest.json`)) as Manifest;
  const build = buildFor(manifest, key);

  core.info(`Downloading Claude Code ${version} (${key}).`);
  const downloaded = await tc.downloadTool(`${RELEASES}/${version}/${key}/${build.binary}`);

  const actual = await sha256(downloaded);
  if (actual !== build.checksum) {
    throw new Error(`Checksum mismatch for Claude Code ${version} (${key}): expected ${build.checksum}, got ${actual}.`);
  }

  const dir = await tc.cacheFile(downloaded, build.binary, TOOL, version, key);
  const executable = path.join(dir, build.binary);
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  return executable;
}
