import * as core from '@actions/core';

import type { CommentView, FailedCheck, Gateway, IssueView, PullView } from './gateway.js';
import { type Status, type StatusLabels } from './statuses.js';

export const LOCK_MARKER = '<!-- issue-runner:lock';
export const PR_MARKER = '<!-- issue-runner:pr';

const LOCK_RUN_PATTERN = /issue-runner:lock run=([0-9A-Za-z_-]+)/;
const PR_NUMBER_PATTERN = /issue-runner:pr number=(\d+)/;
const PR_SHA_PATTERN = /\bsha=([0-9a-f]+)/;
const PR_ATTEMPT_PATTERN = /\battempt=(\d+)/;
const PR_SEEN_PATTERN = /\bseen=([0-9TZ:.-]+)/;

/** Run statuses that mean the run still owns its lock. */
const ALIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export type Decision =
  | { kind: 'busy'; issues: IssueView[] }
  | { kind: 'idle' }
  | { kind: 'claimed'; issue: IssueView };

export interface EngineContext {
  labels: StatusLabels;
  runId: string;
  runUrl: string;
  staleLockMinutes: number;
  maxFixAttempts: number;
  followReviews: boolean;
  now: Date;
}

export type WorkerTask = 'implement' | 'fix-checks' | 'address-review';

/**
 * The state the runner keeps about a pull request, carried in a marker comment.
 *
 * `sha` and `attempt` are what stop a worker from grinding on a commit it cannot fix;
 * `seen` is the watermark that decides which human comments are still unanswered.
 */
export interface PullMarker {
  pull: number;
  sha?: string;
  attempt: number;
  seen?: string;
}

/** An open pull request that needs work before a human can be expected to look again. */
export interface FollowUp {
  issue: IssueView;
  pull: PullView;
  task: Exclude<WorkerTask, 'implement'>;
  failedChecks: FailedCheck[];
  comments: CommentView[];
  /** The marker to post when claiming, with the watermark already advanced. */
  marker: PullMarker;
  reason: string;
}

export interface MergingSweep {
  /** How many issues changed label, so the caller knows to re-read the queue. */
  advanced: number;
  followUp?: FollowUp;
}

// --------------------------------------------------------------- pure helpers

export function parseLockRunId(body: string | undefined): string | undefined {
  return body?.match(LOCK_RUN_PATTERN)?.[1];
}

export function parsePullRequestNumber(body: string | undefined): number | undefined {
  const raw = body?.match(PR_NUMBER_PATTERN)?.[1];
  return raw === undefined ? undefined : Number(raw);
}

export function parsePullMarker(body: string | undefined): PullMarker | undefined {
  const pull = parsePullRequestNumber(body);
  if (pull === undefined) return undefined;
  // Everything is read off the marker line so prose underneath cannot spoof a field.
  const line = body?.split(/\r?\n/).find((l) => l.includes('issue-runner:pr')) ?? '';
  return {
    pull,
    sha: line.match(PR_SHA_PATTERN)?.[1],
    attempt: Number(line.match(PR_ATTEMPT_PATTERN)?.[1] ?? 0),
    seen: line.match(PR_SEEN_PATTERN)?.[1],
  };
}

export function formatPullMarker(marker: PullMarker): string {
  const fields = [`number=${marker.pull}`];
  if (marker.sha !== undefined) fields.push(`sha=${marker.sha}`);
  fields.push(`attempt=${marker.attempt}`);
  if (marker.seen !== undefined) fields.push(`seen=${marker.seen}`);
  return `${PR_MARKER} ${fields.join(' ')} -->`;
}

export function busyIssues(issues: readonly IssueView[], labels: StatusLabels): IssueView[] {
  return issues.filter((issue) => labels.isBusy(issue.labels));
}

export function issuesWith(
  issues: readonly IssueView[],
  labels: StatusLabels,
  status: Status,
): IssueView[] {
  const name = labels.name(status);
  return issues.filter((issue) => issue.labels.includes(name));
}

/**
 * The queue is FIFO by issue number: the oldest admitted issue goes first.
 * A forced issue bypasses the ordering but not the busy check.
 */
export function pickCandidate(
  issues: readonly IssueView[],
  labels: StatusLabels,
  forceIssue?: number,
): IssueView | undefined {
  if (forceIssue !== undefined) {
    return issues.find((issue) => issue.number === forceIssue);
  }
  return issuesWith(issues, labels, 'open').sort((a, b) => a.number - b.number)[0];
}

export function decide(
  issues: readonly IssueView[],
  labels: StatusLabels,
  forceIssue?: number,
): Decision {
  const busy = busyIssues(issues, labels);
  if (busy.length > 0) return { kind: 'busy', issues: busy };

  const candidate = pickCandidate(issues, labels, forceIssue);
  return candidate === undefined ? { kind: 'idle' } : { kind: 'claimed', issue: candidate };
}

export interface ReleaseOutcome {
  target: Status;
  reason: string;
  warning?: string;
}

/**
 * Maps the calling job's outcome, plus whatever the worker declared, onto a status.
 *
 * A worker that succeeds without declaring anything is parked at `blocked` on
 * purpose: a silent worker must stop the queue rather than have it spin on the
 * same issue every hour.
 */
export function resolveRelease(
  jobStatus: string,
  declared: string | undefined,
  hasOpenPull = false,
): ReleaseOutcome {
  switch (jobStatus) {
    case 'cancelled':
      return hasOpenPull
        ? {
            target: 'merging',
            reason:
              'The run was cancelled before finishing. Its pull request is still open, so the ' +
              'issue went back to awaiting review rather than to the back of the queue.',
          }
        : {
            target: 'open',
            reason: 'The run was cancelled before finishing, so the issue was requeued.',
          };
    case 'failure':
      // The pull request, not this run, is the source of truth once one exists. Handing the
      // issue back to `merging` lets the next tick re-read CI; the per-commit guard in
      // followMerging is what stops that from becoming a loop.
      return hasOpenPull
        ? {
            target: 'merging',
            reason: 'The run failed while working on an open pull request, which still stands.',
          }
        : {
            target: 'failed',
            reason: 'The run failed. Fix the cause and relabel it queued to retry.',
          };
    case 'success':
      break;
    default:
      return { target: 'blocked', reason: `Unknown job status \`${jobStatus}\`.` };
  }

  switch (declared) {
    case 'open':
      return { target: 'open', reason: 'The worker asked for a requeue.' };
    case 'merging':
      return { target: 'merging', reason: 'Work is done and awaiting review.' };
    case 'blocked':
      return { target: 'blocked', reason: 'The worker needs a human decision.' };
    case 'done':
      return { target: 'done', reason: 'The worker reported this as finished.' };
    case 'failed':
      return { target: 'failed', reason: 'The worker reported a failure.' };
    case undefined:
    case '':
      return {
        target: 'blocked',
        reason:
          'The worker finished without declaring a next status, so the queue was parked here on purpose.',
        warning: 'no next-status was written; parking at blocked',
      };
    default:
      return {
        target: 'blocked',
        reason: `The worker declared an unknown next status (\`${declared}\`).`,
        warning: `unknown next-status '${declared}'; parking at blocked`,
      };
  }
}

// ------------------------------------------------------------ stateful passes

/**
 * A lock is stale when the run that took it is no longer alive. When no run can
 * be identified - a lock comment that never landed, or a label applied by hand -
 * we fall back to how long it has been held.
 */
async function lockIsStale(
  gateway: Gateway,
  issue: IssueView,
  ctx: EngineContext,
): Promise<boolean> {
  const body = await gateway.findLastMarkerComment(issue.number, LOCK_MARKER);
  const lockRunId = parseLockRunId(body);

  if (lockRunId !== undefined && lockRunId === ctx.runId) {
    core.info(`#${issue.number} is locked by this very run`);
    return false;
  }

  if (lockRunId !== undefined) {
    const status = await gateway.workflowRunStatus(lockRunId);
    if (ALIVE_RUN_STATUSES.has(status)) {
      core.info(`#${issue.number} locked by run ${lockRunId} which is still ${status}`);
      return false;
    }
    core.info(`#${issue.number} locked by run ${lockRunId} which is ${status}`);
    return true;
  }

  const appliedAt =
    (await gateway.labelAppliedAt(issue.number, ctx.labels.name('processing'))) ??
    new Date(issue.updatedAt);
  const heldMinutes = Math.floor((ctx.now.getTime() - appliedAt.getTime()) / 60_000);
  core.info(
    `#${issue.number} has no lock comment; held for ${heldMinutes}m (limit ${ctx.staleLockMinutes}m)`,
  );
  return heldMinutes >= ctx.staleLockMinutes;
}

/**
 * The pull request an issue's last `PR_MARKER` points at, if it is still open.
 *
 * A `status:open` label is not proof that an issue is unclaimed work: a human moving it back
 * from `blocked` - the normal way to retry - does not know from the label alone whether it
 * still carries a pull request. This is the one place that actually asks.
 */
export async function findOpenPull(gateway: Gateway, issue: IssueView): Promise<PullView | undefined> {
  const marker = parsePullMarker(await gateway.findLastMarkerComment(issue.number, PR_MARKER));
  if (marker === undefined) return undefined;
  const pull = await gateway.getPullRequest(marker.pull);
  return pull?.state === 'OPEN' ? pull : undefined;
}

/**
 * Where a reclaimed issue belongs.
 *
 * An issue that already has an open pull request must go back to `merging`, not `open`:
 * requeueing it would hand the same work to a worker that knows nothing about the branch
 * already carrying it, and a second pull request is the one outcome nobody wants.
 */
export async function reclaimTarget(gateway: Gateway, issue: IssueView): Promise<Status> {
  return (await findOpenPull(gateway, issue)) === undefined ? 'open' : 'merging';
}

/** Returns how many issues were moved, so the caller knows to re-read the queue. */
export async function reapStaleLocks(
  gateway: Gateway,
  issues: readonly IssueView[],
  ctx: EngineContext,
): Promise<number> {
  let reclaimed = 0;

  for (const issue of issuesWith(issues, ctx.labels, 'processing')) {
    if (!(await lockIsStale(gateway, issue, ctx))) continue;

    const target = await reclaimTarget(gateway, issue);
    core.warning(`Reclaiming stale lock on #${issue.number} back to ${ctx.labels.name(target)}`);
    await gateway.setStatus(issue.number, issue.labels, ctx.labels.name(target));
    await gateway.addComment(
      issue.number,
      `${LOCK_MARKER} released -->\n` +
        'The run holding this issue is no longer alive, so `issue-runner` released the lock and ' +
        `moved it back to \`${ctx.labels.name(target)}\`. ` +
        `Released by [run #${ctx.runId}](${ctx.runUrl}).`,
    );
    reclaimed++;
  }

  return reclaimed;
}

/**
 * Walks every `merging` issue and decides, from the pull request alone, what happens next.
 *
 * This is the pass that keeps the loop cheap. Merged, closed, still building, green and
 * waiting on a person - all four are answered by a handful of API calls, and none of them
 * starts a worker. Only two things are work: CI went red, or a person asked for something.
 */
export async function followMerging(
  gateway: Gateway,
  issues: readonly IssueView[],
  ctx: EngineContext,
): Promise<MergingSweep> {
  let advanced = 0;
  let followUp: FollowUp | undefined;

  for (const issue of issuesWith(issues, ctx.labels, 'merging')) {
    const marker = parsePullMarker(await gateway.findLastMarkerComment(issue.number, PR_MARKER));
    if (marker === undefined) {
      core.info(`#${issue.number} is merging but has no recorded pull request; leaving it alone`);
      continue;
    }

    const pull = await gateway.getPullRequest(marker.pull);
    if (pull === undefined) {
      core.warning(`#${issue.number}: PR #${marker.pull} no longer exists`);
      await park(gateway, issue, ctx, `PR #${marker.pull} no longer exists.`);
      advanced++;
      continue;
    }

    if (pull.state === 'MERGED') {
      core.notice(`#${issue.number}: PR #${pull.number} merged, closing issue`);
      await gateway.setStatus(issue.number, issue.labels, ctx.labels.name('done'));
      await gateway.addComment(
        issue.number,
        `PR #${pull.number} is merged. \`issue-runner\` marked this ` +
          `\`${ctx.labels.name('done')}\` and closed it.`,
      );
      await gateway.closeIssue(issue.number);
      advanced++;
      continue;
    }

    if (pull.state === 'CLOSED') {
      core.warning(`#${issue.number}: PR #${pull.number} was closed without merging`);
      await park(gateway, issue, ctx, `PR #${pull.number} was closed without merging.`);
      advanced++;
      continue;
    }

    if (pull.draft) {
      core.info(`#${issue.number}: PR #${pull.number} is a draft; waiting`);
      continue;
    }

    // Already carrying work this tick. Keep sweeping so merges and closures are still
    // applied, but do not queue a second worker - only one thing runs at a time.
    if (followUp !== undefined) continue;

    const comments = ctx.followReviews
      ? await gateway.humanCommentsSince(pull.number, marker.seen ?? pull.createdAt)
      : [];
    const checks = await gateway.checksFor(pull.headSha);
    core.info(
      `#${issue.number}: PR #${pull.number} checks are ${checks.verdict}, ` +
        `${comments.length} unanswered comment(s)` +
        // The one case where "none" does not mean "nobody said anything": a review left in
        // draft is visible to its author in the UI and to nobody else, the API included. It
        // looks like a reviewed pull request and reads to the runner as an untouched one.
        // Only worth saying when the tick is about to do nothing and wait on a person -
        // a red pull request is already being worked on, hint or no hint.
        (ctx.followReviews && comments.length === 0 && checks.verdict === 'passing'
          ? ' (a review left unsubmitted is invisible here - press Submit review)'
          : ''),
    );

    if (comments.length > 0) {
      followUp = {
        issue,
        pull,
        task: 'address-review',
        failedChecks: checks.failed,
        comments,
        // A person asking for something is a fresh instruction, so the attempt counter -
        // which exists to stop a worker grinding on CI - is not touched here.
        marker: { ...marker, sha: pull.headSha, seen: ctx.now.toISOString() },
        reason: `${comments.length} unanswered comment(s) on PR #${pull.number}`,
      };
      continue;
    }

    if (checks.verdict !== 'failing') continue;

    if (marker.sha === pull.headSha) {
      core.warning(`#${issue.number}: PR #${pull.number} is still red on ${pull.headSha}`);
      await park(
        gateway,
        issue,
        ctx,
        `PR #${pull.number} is still failing on the same commit \`${pull.headSha.slice(0, 7)}\` ` +
          'after a fix attempt, so the runner stopped rather than trying again.',
      );
      advanced++;
      continue;
    }

    if (marker.attempt >= ctx.maxFixAttempts) {
      core.warning(`#${issue.number}: PR #${pull.number} hit the fix attempt limit`);
      await park(
        gateway,
        issue,
        ctx,
        `PR #${pull.number} has failed CI after ${marker.attempt} fix attempt(s), which is the ` +
          'limit. A human needs to look before the runner tries again.',
      );
      advanced++;
      continue;
    }

    followUp = {
      issue,
      pull,
      task: 'fix-checks',
      failedChecks: checks.failed,
      comments: [],
      marker: { ...marker, sha: pull.headSha, attempt: marker.attempt + 1 },
      reason:
        `${checks.failed.length} failing check(s) on PR #${pull.number} ` +
        `(attempt ${marker.attempt + 1} of ${ctx.maxFixAttempts})`,
    };
  }

  return { advanced, followUp };
}

/** Moves an issue to `blocked` and says why, which is always a human's cue. */
async function park(
  gateway: Gateway,
  issue: IssueView,
  ctx: EngineContext,
  why: string,
): Promise<void> {
  await gateway.setStatus(issue.number, issue.labels, ctx.labels.name('blocked'));
  await gateway.addComment(
    issue.number,
    `${why} \`issue-runner\` marked this \`${ctx.labels.name('blocked')}\`; ` +
      `relabel it \`${ctx.labels.name('open')}\` to requeue.`,
  );
}
