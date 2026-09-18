import { describe, expect, it } from 'vitest';

import {
  decide,
  followMerging,
  formatPullMarker,
  parseLockRunId,
  parsePullMarker,
  parsePullRequestNumber,
  reapStaleLocks,
  resolveRelease,
  type EngineContext,
} from './engine.js';
import type {
  ChecksView,
  CommentView,
  Gateway,
  IssueView,
  PullView,
} from './gateway.js';
import { StatusLabels } from './statuses.js';

const labels = new StatusLabels('status:');

const ctx: EngineContext = {
  labels,
  runId: '999',
  runUrl: 'https://github.test/run/999',
  staleLockMinutes: 120,
  maxFixAttempts: 3,
  followReviews: true,
  now: new Date('2026-09-18T12:00:00Z'),
};

function pull(overrides: Partial<PullView> = {}): PullView {
  return {
    number: 42,
    state: 'OPEN',
    draft: false,
    headSha: 'abc1234',
    headRef: 'issue/1-thing',
    createdAt: '2026-09-18T10:00:00Z',
    url: 'https://github.test/pull/42',
    ...overrides,
  };
}

function comment(overrides: Partial<CommentView> = {}): CommentView {
  return {
    kind: 'comment',
    author: 'a-person',
    createdAt: '2026-09-18T11:30:00Z',
    body: 'Please rename this.',
    url: 'https://github.test/pull/42#c1',
    ...overrides,
  };
}

function issue(number: number, issueLabels: string[], updatedAt = ctx.now.toISOString()): IssueView {
  return {
    number,
    title: `issue ${number}`,
    labels: issueLabels,
    updatedAt,
    body: '',
    url: `https://github.test/issues/${number}`,
    author: 'someone',
  };
}

interface FakeOptions {
  comments?: Record<number, string[]>;
  runStatuses?: Record<string, string>;
  pulls?: Record<number, PullView>;
  labelAppliedAt?: Record<number, Date>;
  checks?: ChecksView;
  humanComments?: CommentView[];
}

interface Recorded {
  statuses: { issue: number; target: string }[];
  comments: { issue: number; body: string }[];
  closed: number[];
}

function fakeGateway(options: FakeOptions = {}): { gateway: Gateway; recorded: Recorded } {
  const recorded: Recorded = { statuses: [], comments: [], closed: [] };

  const gateway: Gateway = {
    ensureLabels: async () => undefined,
    listOpenIssues: async () => [],
    getIssue: async () => undefined,
    setStatus: async (number, _current, target) => {
      recorded.statuses.push({ issue: number, target });
    },
    addComment: async (number, body) => {
      recorded.comments.push({ issue: number, body });
    },
    findLastMarkerComment: async (number, marker) =>
      (options.comments?.[number] ?? []).filter((body) => body.startsWith(marker)).at(-1),
    labelAppliedAt: async (number) => options.labelAppliedAt?.[number],
    workflowRunStatus: async (runId) => options.runStatuses?.[runId] ?? 'missing',
    closeIssue: async (number) => {
      recorded.closed.push(number);
    },
    getPullRequest: async (number) => options.pulls?.[number],
    checksFor: async () => options.checks ?? { verdict: 'none', failed: [] },
    failedJobLogs: async () => 'log tail',
    humanCommentsSince: async () => options.humanComments ?? [],
  };

  return { gateway, recorded };
}

describe('decide', () => {
  it('reports busy when anything is processing, even with work queued', () => {
    const decision = decide(
      [issue(1, ['status:processing']), issue(2, ['status:open'])],
      labels,
    );
    expect(decision.kind).toBe('busy');
  });

  it('reports busy while a pull request is merging', () => {
    const decision = decide([issue(1, ['status:merging']), issue(2, ['status:open'])], labels);
    expect(decision.kind).toBe('busy');
  });

  it('ignores issues with no status label', () => {
    expect(decide([issue(1, []), issue(2, ['bug'])], labels).kind).toBe('idle');
  });

  it('ignores blocked and failed issues rather than stalling on them', () => {
    const decision = decide(
      [issue(1, ['status:blocked']), issue(2, ['status:failed']), issue(3, ['status:open'])],
      labels,
    );
    expect(decision).toMatchObject({ kind: 'claimed', issue: { number: 3 } });
  });

  it('takes the lowest numbered queued issue', () => {
    const decision = decide(
      [issue(9, ['status:open']), issue(4, ['status:open']), issue(7, ['status:open'])],
      labels,
    );
    expect(decision).toMatchObject({ kind: 'claimed', issue: { number: 4 } });
  });

  it('honours a forced issue even without the queued label', () => {
    const decision = decide([issue(1, ['status:open']), issue(5, [])], labels, 5);
    expect(decision).toMatchObject({ kind: 'claimed', issue: { number: 5 } });
  });

  it('refuses to force an issue past a busy queue', () => {
    expect(decide([issue(1, ['status:processing']), issue(5, [])], labels, 5).kind).toBe('busy');
  });

  it('respects a custom label prefix', () => {
    const custom = new StatusLabels('queue/');
    expect(decide([issue(1, ['queue/open'])], custom)).toMatchObject({ kind: 'claimed' });
    expect(decide([issue(1, ['status:open'])], custom).kind).toBe('idle');
  });
});

describe('resolveRelease', () => {
  it('requeues a cancelled run', () => {
    expect(resolveRelease('cancelled', 'merging').target).toBe('open');
  });

  it('marks a failed job failed regardless of what the worker declared', () => {
    expect(resolveRelease('failure', 'done').target).toBe('failed');
  });

  it('parks a silent but successful worker at blocked', () => {
    const outcome = resolveRelease('success', undefined);
    expect(outcome.target).toBe('blocked');
    expect(outcome.warning).toBeDefined();
  });

  it('parks an unknown declaration at blocked', () => {
    expect(resolveRelease('success', 'whatever').target).toBe('blocked');
  });

  it('follows the worker on success', () => {
    expect(resolveRelease('success', 'merging').target).toBe('merging');
    expect(resolveRelease('success', 'done').target).toBe('done');
    expect(resolveRelease('success', 'open').target).toBe('open');
  });
});

describe('reapStaleLocks', () => {
  it('leaves a lock held by a live run alone', async () => {
    const { gateway, recorded } = fakeGateway({
      comments: { 1: ['<!-- issue-runner:lock run=123 -->'] },
      runStatuses: { '123': 'in_progress' },
    });
    expect(await reapStaleLocks(gateway, [issue(1, ['status:processing'])], ctx)).toBe(0);
    expect(recorded.statuses).toEqual([]);
  });

  it('reclaims a lock whose run has finished', async () => {
    const { gateway, recorded } = fakeGateway({
      comments: { 1: ['<!-- issue-runner:lock run=123 -->'] },
      runStatuses: { '123': 'completed' },
    });
    expect(await reapStaleLocks(gateway, [issue(1, ['status:processing'])], ctx)).toBe(1);
    expect(recorded.statuses).toEqual([{ issue: 1, target: 'status:open' }]);
  });

  it('reclaims a lock whose run no longer exists', async () => {
    const { gateway, recorded } = fakeGateway({
      comments: { 1: ['<!-- issue-runner:lock run=123 -->'] },
    });
    expect(await reapStaleLocks(gateway, [issue(1, ['status:processing'])], ctx)).toBe(1);
    expect(recorded.statuses).toEqual([{ issue: 1, target: 'status:open' }]);
  });

  it('never reclaims the lock held by the current run', async () => {
    const { gateway } = fakeGateway({
      comments: { 1: [`<!-- issue-runner:lock run=${ctx.runId} -->`] },
      runStatuses: { [ctx.runId]: 'completed' },
    });
    expect(await reapStaleLocks(gateway, [issue(1, ['status:processing'])], ctx)).toBe(0);
  });

  it('falls back to age when no lock comment exists', async () => {
    const fresh = fakeGateway({
      labelAppliedAt: { 1: new Date('2026-09-18T11:00:00Z') }, // 60 minutes
    });
    expect(await reapStaleLocks(fresh.gateway, [issue(1, ['status:processing'])], ctx)).toBe(0);

    const old = fakeGateway({
      labelAppliedAt: { 1: new Date('2026-09-18T08:00:00Z') }, // 240 minutes
    });
    expect(await reapStaleLocks(old.gateway, [issue(1, ['status:processing'])], ctx)).toBe(1);
  });

  it('uses the newest lock comment when an issue has been claimed twice', async () => {
    const { gateway } = fakeGateway({
      comments: {
        1: ['<!-- issue-runner:lock run=111 -->', '<!-- issue-runner:lock run=222 -->'],
      },
      runStatuses: { '111': 'completed', '222': 'in_progress' },
    });
    expect(await reapStaleLocks(gateway, [issue(1, ['status:processing'])], ctx)).toBe(0);
  });
});

describe('followMerging', () => {
  const merging = [issue(1, ['status:merging'])];
  const marker = (fields: string) => ({
    comments: { 1: [`<!-- issue-runner:pr ${fields} -->`] },
  });

  it('closes the issue once its pull request is merged', async () => {
    const { gateway, recorded } = fakeGateway({
      ...marker('number=42'),
      pulls: { 42: pull({ state: 'MERGED' }) },
    });
    const sweep = await followMerging(gateway, merging, ctx);
    expect(sweep.advanced).toBe(1);
    expect(sweep.followUp).toBeUndefined();
    expect(recorded.statuses).toEqual([{ issue: 1, target: 'status:done' }]);
    expect(recorded.closed).toEqual([1]);
  });

  it('blocks the issue when its pull request is closed unmerged', async () => {
    const { gateway, recorded } = fakeGateway({
      ...marker('number=42'),
      pulls: { 42: pull({ state: 'CLOSED' }) },
    });
    expect((await followMerging(gateway, merging, ctx)).advanced).toBe(1);
    expect(recorded.statuses).toEqual([{ issue: 1, target: 'status:blocked' }]);
    expect(recorded.closed).toEqual([]);
  });

  it('blocks the issue when its pull request has vanished', async () => {
    const { gateway, recorded } = fakeGateway(marker('number=42'));
    expect((await followMerging(gateway, merging, ctx)).advanced).toBe(1);
    expect(recorded.statuses).toEqual([{ issue: 1, target: 'status:blocked' }]);
  });

  it('leaves a merging issue with no recorded pull request to a human', async () => {
    const { gateway, recorded } = fakeGateway();
    const sweep = await followMerging(gateway, merging, ctx);
    expect(sweep).toEqual({ advanced: 0, followUp: undefined });
    expect(recorded.statuses).toEqual([]);
  });

  it('waits while the checks are still running', async () => {
    const { gateway } = fakeGateway({
      ...marker('number=42'),
      pulls: { 42: pull() },
      checks: { verdict: 'pending', failed: [] },
    });
    expect((await followMerging(gateway, merging, ctx)).followUp).toBeUndefined();
  });

  it('waits when the checks are green and nobody has commented', async () => {
    const { gateway } = fakeGateway({
      ...marker('number=42'),
      pulls: { 42: pull() },
      checks: { verdict: 'passing', failed: [] },
    });
    expect((await followMerging(gateway, merging, ctx)).followUp).toBeUndefined();
  });

  it('waits on a draft pull request without asking anything about it', async () => {
    const { gateway } = fakeGateway({
      ...marker('number=42'),
      pulls: { 42: pull({ draft: true }) },
      checks: { verdict: 'failing', failed: [{ name: 'tests', conclusion: 'failure', url: '' }] },
    });
    expect((await followMerging(gateway, merging, ctx)).followUp).toBeUndefined();
  });

  it('hands a red pull request back for a fix and counts the attempt', async () => {
    const { gateway } = fakeGateway({
      ...marker('number=42'),
      pulls: { 42: pull() },
      checks: { verdict: 'failing', failed: [{ name: 'tests', conclusion: 'failure', url: 'u' }] },
    });
    const { followUp } = await followMerging(gateway, merging, ctx);
    expect(followUp?.task).toBe('fix-checks');
    expect(followUp?.failedChecks).toHaveLength(1);
    expect(followUp?.marker).toMatchObject({ pull: 42, sha: 'abc1234', attempt: 1 });
  });

  it('refuses to attempt the same commit twice', async () => {
    const { gateway, recorded } = fakeGateway({
      ...marker('number=42 sha=abc1234 attempt=1'),
      pulls: { 42: pull() },
      checks: { verdict: 'failing', failed: [{ name: 'tests', conclusion: 'failure', url: '' }] },
    });
    const sweep = await followMerging(gateway, merging, ctx);
    expect(sweep.followUp).toBeUndefined();
    expect(recorded.statuses).toEqual([{ issue: 1, target: 'status:blocked' }]);
  });

  it('parks the issue once the fix attempts run out', async () => {
    const { gateway, recorded } = fakeGateway({
      ...marker('number=42 sha=0ldsha attempt=3'),
      pulls: { 42: pull() },
      checks: { verdict: 'failing', failed: [{ name: 'tests', conclusion: 'failure', url: '' }] },
    });
    const sweep = await followMerging(gateway, merging, ctx);
    expect(sweep.followUp).toBeUndefined();
    expect(recorded.statuses).toEqual([{ issue: 1, target: 'status:blocked' }]);
  });

  it('treats an unanswered human comment as work', async () => {
    const { gateway } = fakeGateway({
      ...marker('number=42'),
      pulls: { 42: pull() },
      checks: { verdict: 'passing', failed: [] },
      humanComments: [comment()],
    });
    const { followUp } = await followMerging(gateway, merging, ctx);
    expect(followUp?.task).toBe('address-review');
    expect(followUp?.comments).toHaveLength(1);
    expect(followUp?.marker.seen).toBe(ctx.now.toISOString());
  });

  it('does not spend a fix attempt on a review, so the CI budget stays intact', async () => {
    const { gateway } = fakeGateway({
      ...marker('number=42 attempt=2'),
      pulls: { 42: pull() },
      checks: { verdict: 'failing', failed: [{ name: 'tests', conclusion: 'failure', url: '' }] },
      humanComments: [comment()],
    });
    const { followUp } = await followMerging(gateway, merging, ctx);
    expect(followUp?.task).toBe('address-review');
    expect(followUp?.marker.attempt).toBe(2);
    // The red checks still travel with it - one pass fixes both.
    expect(followUp?.failedChecks).toHaveLength(1);
  });

  it('never asks about comments when review following is switched off', async () => {
    const { gateway } = fakeGateway({
      ...marker('number=42'),
      pulls: { 42: pull() },
      checks: { verdict: 'passing', failed: [] },
      humanComments: [comment()],
    });
    const sweep = await followMerging(gateway, merging, { ...ctx, followReviews: false });
    expect(sweep.followUp).toBeUndefined();
  });

  it('starts at most one follow-up per tick', async () => {
    const { gateway } = fakeGateway({
      comments: {
        1: ['<!-- issue-runner:pr number=42 -->'],
        2: ['<!-- issue-runner:pr number=43 -->'],
      },
      pulls: { 42: pull(), 43: pull({ number: 43 }) },
      checks: { verdict: 'failing', failed: [{ name: 'tests', conclusion: 'failure', url: '' }] },
    });
    const sweep = await followMerging(
      gateway,
      [issue(1, ['status:merging']), issue(2, ['status:merging'])],
      ctx,
    );
    expect(sweep.followUp?.issue.number).toBe(1);
  });
});

describe('reclaiming an issue that already has a pull request', () => {
  it('sends it back to merging rather than to the back of the queue', async () => {
    const { gateway, recorded } = fakeGateway({
      comments: {
        1: ['<!-- issue-runner:lock run=123 -->', '<!-- issue-runner:pr number=42 -->'],
      },
      runStatuses: { '123': 'completed' },
      pulls: { 42: pull() },
    });
    expect(await reapStaleLocks(gateway, [issue(1, ['status:processing'])], ctx)).toBe(1);
    expect(recorded.statuses).toEqual([{ issue: 1, target: 'status:merging' }]);
  });

  it('requeues normally when the pull request is already closed', async () => {
    const { gateway, recorded } = fakeGateway({
      comments: {
        1: ['<!-- issue-runner:lock run=123 -->', '<!-- issue-runner:pr number=42 -->'],
      },
      runStatuses: { '123': 'completed' },
      pulls: { 42: pull({ state: 'CLOSED' }) },
    });
    expect(await reapStaleLocks(gateway, [issue(1, ['status:processing'])], ctx)).toBe(1);
    expect(recorded.statuses).toEqual([{ issue: 1, target: 'status:open' }]);
  });
});

describe('release with a pull request still open', () => {
  it('sends a cancelled run back to merging instead of requeueing the issue', () => {
    expect(resolveRelease('cancelled', undefined, true).target).toBe('merging');
    expect(resolveRelease('cancelled', undefined, false).target).toBe('open');
  });

  it('sends a failed run back to merging, where the next tick re-reads CI', () => {
    expect(resolveRelease('failure', undefined, true).target).toBe('merging');
    expect(resolveRelease('failure', undefined, false).target).toBe('failed');
  });
});

describe('marker parsing', () => {
  it('reads a run id', () => {
    expect(parseLockRunId('<!-- issue-runner:lock run=12345 -->\ntext')).toBe('12345');
    expect(parseLockRunId('<!-- issue-runner:lock released -->')).toBeUndefined();
    expect(parseLockRunId(undefined)).toBeUndefined();
  });

  it('reads a pull request number', () => {
    expect(parsePullRequestNumber('<!-- issue-runner:pr number=7 -->')).toBe(7);
    expect(parsePullRequestNumber('nothing here')).toBeUndefined();
  });

  it('defaults the attempt counter for a marker written before it existed', () => {
    expect(parsePullMarker('<!-- issue-runner:pr number=7 -->')).toEqual({
      pull: 7,
      sha: undefined,
      attempt: 0,
      seen: undefined,
    });
  });

  it('survives a round trip through the comment body', () => {
    const marker = { pull: 7, sha: 'deadbee', attempt: 2, seen: '2026-09-18T12:00:00.000Z' };
    expect(parsePullMarker(`${formatPullMarker(marker)}\nsome prose`)).toEqual(marker);
  });

  it('ignores fields in the prose under the marker, which anyone can write', () => {
    const body = `${formatPullMarker({ pull: 7, attempt: 1 })}\nattempt=99 sha=fffffff`;
    expect(parsePullMarker(body)).toMatchObject({ attempt: 1, sha: undefined });
  });
});
