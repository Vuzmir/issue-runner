import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Gateway, IssueView, NewPullRequest, PullView } from './gateway.js';
import {
  branchNameFor,
  currentBranch,
  salvageCommitMessage,
  salvageFollowUpComment,
  salvagePartialWork,
  salvagePullRequestBody,
  type SalvageContext,
} from './salvage.js';

const issue: IssueView = {
  number: 7,
  title: 'Something to do',
  labels: ['status:processing'],
  updatedAt: '2026-09-18T12:00:00Z',
  body: 'The body.',
  url: 'https://github.test/issues/7',
  author: 'someone',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let root: string;
let origin: string;
let workspace: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-runner-salvage-'));
  origin = path.join(root, 'origin.git');
  workspace = path.join(root, 'workspace');

  fs.mkdirSync(origin);
  git(['init', '--bare', '-b', 'main'], origin);

  fs.mkdirSync(workspace);
  git(['init', '-b', 'main'], workspace);
  git(['config', 'user.email', 'test@example.com'], workspace);
  git(['config', 'user.name', 'Test'], workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), 'hello\n');
  git(['add', '-A'], workspace);
  git(['commit', '-m', 'initial'], workspace);
  git(['remote', 'add', 'origin', origin], workspace);
  git(['push', '-u', 'origin', 'main'], workspace);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeGateway(): { addComment: (issue: number, body: string) => Promise<void>; calls: { issue: number; body: string }[] } {
  const calls: { issue: number; body: string }[] = [];
  return {
    calls,
    addComment: async (issueNumber, body) => {
      calls.push({ issue: issueNumber, body });
    },
  };
}

function ctxFor(overrides: Partial<SalvageContext> = {}): SalvageContext {
  return {
    cwd: workspace,
    issue,
    task: 'implement',
    initialBranch: 'main',
    reason: 'Claude AI usage limit reached|1760000400',
    owner: 'acme',
    repo: 'widgets',
    githubToken: 'token',
    ...overrides,
  };
}

describe('branchNameFor', () => {
  it('names a stable branch keyed only by the issue number', () => {
    expect(branchNameFor(7)).toBe('issue/7-usage-limit');
  });
});

describe('salvageCommitMessage / salvagePullRequestBody / salvageFollowUpComment', () => {
  it('names the issue and says plainly why the run stopped', () => {
    expect(salvageCommitMessage(issue)).toContain('Refs #7');
    expect(salvagePullRequestBody(issue, 'boom')).toContain('incomplete');
    expect(salvagePullRequestBody(issue, 'boom')).toContain('boom');
    expect(salvageFollowUpComment('boom')).toContain('incomplete');
    expect(salvageFollowUpComment('boom')).toContain('boom');
  });
});

describe('currentBranch', () => {
  it('reads the branch a workspace is on', () => {
    expect(currentBranch(workspace)).toBe('main');
  });

  it('returns an empty string rather than throwing when the directory is not a git repo', () => {
    expect(currentBranch(root)).toBe('');
  });
});

describe('salvagePartialWork', () => {
  it('does nothing when the workspace is clean', async () => {
    const fake = fakeGateway();
    const outcome = await salvagePartialWork(fake as unknown as Gateway, ctxFor());
    expect(outcome).toEqual({ committed: false });
    expect(fake.calls).toEqual([]);
  });

  it('commits, branches off and opens a draft pull request for a fresh implement claim', async () => {
    fs.writeFileSync(path.join(workspace, 'work.txt'), 'half a feature\n');
    const fake = fakeGateway();

    const openPull = vi.fn(async (_token: string, _owner: string, _repo: string, _params: NewPullRequest): Promise<PullView> => ({
      number: 99,
      state: 'OPEN',
      draft: true,
      headSha: 'deadbeef',
      headRef: 'issue/7-usage-limit',
      createdAt: '2026-09-19T00:00:00Z',
      url: 'https://github.test/pull/99',
    }));

    const outcome = await salvagePartialWork(fake as unknown as Gateway, ctxFor(), openPull);

    expect(outcome).toEqual({ committed: true, pull: { number: 99 } });
    expect(currentBranch(workspace)).toBe('issue/7-usage-limit');
    expect(git(['status', '--porcelain'], workspace).trim()).toBe('');

    expect(openPull).toHaveBeenCalledTimes(1);
    const [token, owner, repo, params] = openPull.mock.calls[0]!;
    expect(token).toBe('token');
    expect(owner).toBe('acme');
    expect(repo).toBe('widgets');
    expect(params).toMatchObject({ head: 'issue/7-usage-limit', base: 'main', draft: true });
    expect(params.title).toContain('WIP');
    expect(params.body).toContain('incomplete');

    // Pushed for real, to the fake origin - not just committed locally.
    const onOrigin = git(['branch', '--list', 'issue/7-usage-limit'], origin);
    expect(onOrigin).toContain('issue/7-usage-limit');
  });

  it('reuses the branch the worker already switched to, rather than branching again', async () => {
    git(['switch', '-c', 'issue/7-already-branched'], workspace);
    fs.writeFileSync(path.join(workspace, 'work.txt'), 'half a feature\n');
    const fake = fakeGateway();
    const openPull = vi.fn(async (_token: string, _owner: string, _repo: string, _params: NewPullRequest): Promise<PullView> => ({
      number: 99,
      state: 'OPEN',
      draft: true,
      headSha: 'deadbeef',
      headRef: 'issue/7-already-branched',
      createdAt: '2026-09-19T00:00:00Z',
      url: 'https://github.test/pull/99',
    }));

    await salvagePartialWork(fake as unknown as Gateway, ctxFor(), openPull);

    expect(currentBranch(workspace)).toBe('issue/7-already-branched');
    expect(openPull.mock.calls[0]?.[3]).toMatchObject({ head: 'issue/7-already-branched' });
  });

  it('commits and pushes onto an existing pull request branch for a follow-up task', async () => {
    git(['switch', '-c', 'issue/7-fix'], workspace);
    git(['push', '-u', 'origin', 'issue/7-fix'], workspace);
    fs.writeFileSync(path.join(workspace, 'work.txt'), 'a partial fix\n');
    const fake = fakeGateway();

    const outcome = await salvagePartialWork(
      fake as unknown as Gateway,
      ctxFor({ task: 'fix-checks', existingPull: { number: 42, headRef: 'issue/7-fix' } }),
    );

    expect(outcome).toEqual({ committed: true });
    expect(fake.calls).toEqual([{ issue: 42, body: expect.stringContaining('incomplete') }]);
    expect(git(['status', '--porcelain'], workspace).trim()).toBe('');

    const onOrigin = git(['log', 'issue/7-fix', '--oneline'], origin);
    expect(onOrigin).toContain('WIP: Something to do');
  });

  it('refuses to guess when the workspace is not on the pull request branch it expected', async () => {
    fs.writeFileSync(path.join(workspace, 'work.txt'), 'a partial fix\n');
    const fake = fakeGateway();
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => undefined);

    const outcome = await salvagePartialWork(
      fake as unknown as Gateway,
      ctxFor({ task: 'fix-checks', existingPull: { number: 42, headRef: 'issue/7-fix' } }),
    );

    expect(outcome).toEqual({ committed: false });
    expect(fake.calls).toEqual([]);
    // The change is left exactly as the worker left it - not committed, not lost.
    expect(git(['status', '--porcelain'], workspace).trim()).not.toBe('');
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it('warns and reports nothing salvaged rather than throwing when a git command fails', async () => {
    fs.writeFileSync(path.join(workspace, 'work.txt'), 'half a feature\n');
    const fake = fakeGateway();
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => undefined);

    // No remote to push to - the commit succeeds, the push does not.
    git(['remote', 'remove', 'origin'], workspace);

    const outcome = await salvagePartialWork(fake as unknown as Gateway, ctxFor());

    expect(outcome).toEqual({ committed: false });
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
