import * as path from 'node:path';

import * as core from '@actions/core';
import { context } from '@actions/github';

import { StatusLabels } from './statuses.js';

export interface Config {
  token: string;
  owner: string;
  repo: string;
  labels: StatusLabels;
  staleLockMinutes: number;
  maxFixAttempts: number;
  followReviews: boolean;
  dryRun: boolean;
  forceIssue: number | undefined;
  stateDir: string;
  runId: string;
  runUrl: string;
  /** worker */
  model: string;
  claudeVersion: string;
  nodeVersion: string;
  claudeToken: string;
  githubToken: string;
}

/**
 * `core.getBooleanInput` throws on an empty value, and an empty value is exactly
 * what a `workflow_dispatch` input evaluates to on a `schedule` run.
 */
function booleanInput(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === '') return fallback;
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`Input '${name}' must be true or false, got '${raw}'.`);
}

function optionalNumber(name: string): number | undefined {
  const raw = core.getInput(name).trim();
  if (raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Input '${name}' must be a positive integer, got '${raw}'.`);
  }
  return value;
}

export function readConfig(): Config {
  const prefix = core.getInput('label-prefix').trim() || 'status:';
  const staleLockMinutes = optionalNumber('stale-lock-minutes') ?? 120;
  const maxFixAttempts = optionalNumber('max-fix-attempts') ?? 3;

  const runnerTemp = process.env['RUNNER_TEMP'] ?? process.env['TMPDIR'] ?? '.';
  const stateDir =
    core.getInput('state-dir').trim() || path.join(runnerTemp, 'issue-runner');

  const runId = process.env['GITHUB_RUN_ID'] ?? 'local';
  const server = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com';
  const { owner, repo } = context.repo;

  return {
    token: core.getInput('token', { required: true }),
    owner,
    repo,
    labels: new StatusLabels(prefix),
    staleLockMinutes,
    maxFixAttempts,
    followReviews: booleanInput('follow-reviews', true),
    dryRun: booleanInput('dry-run', false),
    forceIssue: optionalNumber('force-issue'),
    stateDir,
    runId,
    runUrl: `${server}/${owner}/${repo}/actions/runs/${runId}`,
    model: core.getInput('model', { required: true }),
    claudeVersion: core.getInput('version', { required: true }),
    nodeVersion: core.getInput('node-version', { required: true }),
    claudeToken: core.getInput('claude-token'),
    // Not required here: an idle or busy tick never touches it, and should not need the
    // secret configured to run at all. `runWorker` requires it once an issue is claimed.
    githubToken: core.getInput('github-token'),
  };
}

export function issueUrl(config: Config, issue: number): string {
  const server = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com';
  return `${server}/${config.owner}/${config.repo}/issues/${issue}`;
}
