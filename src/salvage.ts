// What happens to a run's diff when Claude hits a usage limit mid-session and never reaches
// Phase 4 of PROTOCOL.md - the phase that commits, pushes and opens the pull request.
//
// The workspace on disk does not know the difference between "finished" and "cut off": it
// just has whatever edits made it in before the CLI stopped. Losing that work and requeueing
// from scratch wastes it and the tokens it cost, so this salvages what it can - a commit, a
// push, and a pull request or a comment saying plainly that the change is incomplete - rather
// than letting it evaporate with the workspace.

import { execFileSync } from 'node:child_process';

import * as core from '@actions/core';

import { GIT_EMAIL, GIT_NAME } from './claude.js';
import type { WorkerTask } from './engine.js';
import { openPullRequest, type Gateway, type IssueView } from './gateway.js';

export function branchNameFor(issueNumber: number): string {
  return `issue/${issueNumber}-usage-limit`;
}

export function salvageCommitMessage(issue: IssueView): string {
  return `WIP: ${issue.title}\n\nInterrupted partway through by a Claude usage limit. Refs #${issue.number}`;
}

function why(reason: string): string {
  return ['<details><summary>Why the run stopped</summary>', '', '```', reason, '```', '', '</details>'].join('\n');
}

export function salvagePullRequestBody(issue: IssueView, reason: string): string {
  return [
    `Partial work on #${issue.number}, committed by \`issue-runner\` after Claude hit a usage limit mid-run.`,
    '',
    '**This change is incomplete.** Mark it ready for review once you have checked it over and ' +
      'finished what it is missing, or close it and relabel the issue `status:open` to let the ' +
      'runner start over once the limit resets.',
    '',
    why(reason),
  ].join('\n');
}

export function salvageFollowUpComment(reason: string): string {
  return [
    '`issue-runner` committed the work in progress here after Claude hit a usage limit mid-run. ' +
      'This push is **incomplete** - review it before merging.',
    '',
    why(reason),
  ].join('\n');
}

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The branch the workspace is on right now, or `''` if that cannot be read. Read this before
 * the worker runs - it is the "never push here directly" branch a salvage compares against,
 * and that comparison is only meaningful against the state the workspace started this run in.
 */
export function currentBranch(cwd: string): string {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, process.env).trim();
  } catch {
    return '';
  }
}

export interface SalvageContext {
  cwd: string;
  issue: IssueView;
  task: WorkerTask;
  /** The branch the workspace was on before the worker ran - never a valid push target. */
  initialBranch: string;
  /** The pull request a follow-up (`fix-checks`/`address-review`) was already working on. */
  existingPull?: { number: number; headRef: string };
  reason: string;
  owner: string;
  repo: string;
  /**
   * The token a fresh pull request must be opened with - the same one `runWorker` hands the
   * CLI for `gh pr create`, and deliberately not whatever the gateway carries: many
   * repositories forbid Actions from opening pull requests with the default token.
   */
  githubToken: string;
}

export interface SalvageOutcome {
  committed: boolean;
  /** Set only when this salvage had to open a fresh pull request for the work. */
  pull?: { number: number };
}

const NOTHING: SalvageOutcome = { committed: false };

/**
 * Commits whatever the interrupted worker left in the workspace, so a usage limit costs a
 * requeue rather than the diff itself. Never throws - a salvage attempt that itself fails
 * must not turn an already-recoverable situation into a worse one, so every failure here is a
 * warning and a fallback to "nothing was salvaged," not a thrown error.
 */
export async function salvagePartialWork(
  gateway: Gateway,
  ctx: SalvageContext,
  // Overridable so a test can hand in a fake rather than reach the real GitHub API - the only
  // real caller ever leaves this at its default.
  openPull: typeof openPullRequest = openPullRequest,
): Promise<SalvageOutcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_NAME,
    GIT_AUTHOR_EMAIL: GIT_EMAIL,
    GIT_COMMITTER_NAME: GIT_NAME,
    GIT_COMMITTER_EMAIL: GIT_EMAIL,
  };

  try {
    if (git(['status', '--porcelain'], ctx.cwd, env).trim() === '') return NOTHING;

    const branchNow = currentBranch(ctx.cwd);

    if (ctx.task !== 'implement') {
      const pull = ctx.existingPull;
      // Too ambiguous to guess at: the worker is supposed to check the pull request's branch
      // out in Phase 1, before anything else, so anything else here means it was interrupted
      // before that happened and this diff cannot be attributed to that branch with confidence.
      if (pull === undefined || branchNow !== pull.headRef) {
        core.warning(
          `#${ctx.issue.number}: uncommitted changes exist but the workspace is not on the pull ` +
            `request's branch (on ${branchNow}); leaving them uncommitted rather than guessing.`,
        );
        return NOTHING;
      }
      git(['add', '-A'], ctx.cwd, env);
      git(['commit', '-m', salvageCommitMessage(ctx.issue)], ctx.cwd, env);
      git(['push', 'origin', `HEAD:${pull.headRef}`], ctx.cwd, env);
      await gateway.addComment(pull.number, salvageFollowUpComment(ctx.reason));
      return { committed: true };
    }

    // A fresh `implement` claim starts on the default branch; if the worker never got as far
    // as Phase 2's `git switch -c`, the diff is still sitting there and pushing it as-is would
    // land on the branch nothing is allowed to push to directly.
    const branch = branchNow === ctx.initialBranch ? branchNameFor(ctx.issue.number) : branchNow;
    if (branch !== branchNow) git(['switch', '-c', branch], ctx.cwd, env);
    git(['add', '-A'], ctx.cwd, env);
    git(['commit', '-m', salvageCommitMessage(ctx.issue)], ctx.cwd, env);
    git(['push', '-u', 'origin', branch], ctx.cwd, env);

    // Draft, deliberately: this is unreviewed, LLM-truncated work the runner is opening on
    // nobody's behalf. `followMerging` already knows to leave drafts alone until a human marks
    // one ready, which is exactly the checkpoint a commit nobody asked for should wait behind.
    const pull = await openPull(ctx.githubToken, ctx.owner, ctx.repo, {
      title: `WIP: ${ctx.issue.title}`,
      body: salvagePullRequestBody(ctx.issue, ctx.reason),
      head: branch,
      base: ctx.initialBranch,
      draft: true,
    });
    return { committed: true, pull: { number: pull.number } };
  } catch (error: unknown) {
    core.warning(
      `#${ctx.issue.number}: could not salvage the interrupted run's changes: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return NOTHING;
  }
}
