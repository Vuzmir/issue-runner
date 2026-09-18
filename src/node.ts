// Getting a `node` onto PATH for the shell commands the CLI runs on our behalf - the
// run-tests skill's own script chief among them.
//
// A self-hosted runner image built only to execute Actions (myoung34/github-runner, GitHub's
// own Windows service account) is not guaranteed to expose one. The runner agent embeds a
// Node of its own to execute JavaScript actions like this one, but that copy sits outside
// PATH on purpose, and nothing a later shell command spawns inherits it. This installs a real
// one the same way install.ts gets the CLI: downloaded, checksum-verified, cached per
// version, and added to PATH for every process this job still spawns - the worker's own
// child included.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';

import { getText } from './http.js';
import { musl } from './install.js';

const DIST = 'https://nodejs.org/dist';
const TOOL = 'node';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

interface Release {
  version: string;
  lts: string | false;
}

interface Asset {
  /** File name inside the release, and the last segment of the download URL. */
  archive: string;
  /** The archive's own top-level directory once extracted. */
  root: string;
  extract: (file: string, dest: string) => Promise<string>;
  /** Where `node` (or `node.exe`) sits inside the extracted tree. */
  binDir: (extractedRoot: string) => string;
}

export function assetFor(platform: string, arch: string, version: string): Asset {
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Node.js has no build for ${platform}-${arch}.`);

  // Node.js publishes glibc builds only; the official tarball simply fails to run on musl
  // (Alpine). Better to say so now than to hand back a binary that segfaults on first use.
  if (platform === 'linux' && musl()) {
    throw new Error('Node.js has no official musl build; use a glibc-based (e.g. Ubuntu) runner image.');
  }

  if (platform === 'win32') {
    const root = `node-v${version}-win-${arch}`;
    return { archive: `${root}.zip`, root, extract: tc.extractZip, binDir: (extractedRoot) => extractedRoot };
  }
  if (platform === 'linux' || platform === 'darwin') {
    const root = `node-v${version}-${platform}-${arch}`;
    return { archive: `${root}.tar.gz`, root, extract: tc.extractTar, binDir: (extractedRoot) => path.join(extractedRoot, 'bin') };
  }
  throw new Error(`Node.js has no build for ${platform}-${arch}.`);
}

export function checksumFor(shasums: string, archive: string): string {
  for (const line of shasums.split('\n')) {
    const [checksum, name] = line.trim().split(/\s+/);
    if (name === archive) {
      if (checksum === undefined || !CHECKSUM_PATTERN.test(checksum)) {
        throw new Error(`SHASUMS256.txt lists no usable checksum for ${archive}.`);
      }
      return checksum;
    }
  }
  throw new Error(`SHASUMS256.txt lists no entry for ${archive}.`);
}

/** `lts` and `latest` resolve against the release index; anything else is asked for by number. */
export async function resolveNodeVersion(requested: string): Promise<string> {
  if (VERSION_PATTERN.test(requested)) return requested;
  if (requested !== 'lts' && requested !== 'latest') {
    throw new Error(`'${requested}' is not a Node.js version, and not 'lts' or 'latest' either.`);
  }

  const releases = JSON.parse(await getText(`${DIST}/index.json`)) as Release[];
  const match = requested === 'latest' ? releases[0] : releases.find((release) => release.lts !== false);
  if (match === undefined) throw new Error(`The Node.js release index named no '${requested}' version.`);
  return match.version.replace(/^v/, '');
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Installs Node.js into the tool cache, if this runner has not already cached that version, and adds it to PATH. */
export async function ensureNode(requested: string): Promise<void> {
  const version = await resolveNodeVersion(requested);
  const platform = process.platform;
  const arch = process.arch;

  const cached = tc.find(TOOL, version, arch);
  if (cached !== '') {
    core.addPath(platform === 'win32' ? cached : path.join(cached, 'bin'));
    core.info(`Node.js ${version} is already cached on this runner.`);
    return;
  }

  const asset = assetFor(platform, arch, version);

  const shasums = await getText(`${DIST}/v${version}/SHASUMS256.txt`);
  const checksum = checksumFor(shasums, asset.archive);

  core.info(`Downloading Node.js ${version} (${platform}-${arch}).`);
  const downloaded = await tc.downloadTool(`${DIST}/v${version}/${asset.archive}`);

  const actual = await sha256(downloaded);
  if (actual !== checksum) {
    throw new Error(`Checksum mismatch for Node.js ${version} (${platform}-${arch}): expected ${checksum}, got ${actual}.`);
  }

  const extracted = await asset.extract(downloaded, path.join(os.tmpdir(), `node-${version}-${arch}`));
  const cachedRoot = await tc.cacheDir(path.join(extracted, asset.root), TOOL, version, arch);
  core.addPath(asset.binDir(cachedRoot));
}
