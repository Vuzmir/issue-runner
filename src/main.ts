import * as fs from 'node:fs';
import * as path from 'node:path';

import * as core from '@actions/core';

import { type Config, issueUrl, readConfig } from './config.js';
import { GitHubGateway, type Gateway, type IssueView } from './gateway.js';
import {
  LOCK_MARKER,
  PR_MARKER,
  decide,
  followMerging,
  formatPullMarker,
  issuesWith,
  parsePullMarker,
  reapStaleLocks,
  resolveRelease,
  type EngineContext,
  type FollowUp,
} from './engine.js';
import { protocolSource, publishWorkerInput, type FollowUpInput } from './worker.js';

function contextOf(config: Config): EngineContext {
  return {
    labels: config.labels,
    runId: config.runId,
    runUrl: config.runUrl,
    staleLockMinutes: config.staleLockMinutes,
    maxFixAttempts: config.maxFixAttempts,
    followReviews: config.followReviews,
    now: new Date(),
  };
}

function readStateFile(config: Config, name: string): string | undefined {
  const file = path.join(config.stateDir, name);
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, 'utf8').trim();
}

function link(config: Config, issue: IssueView): string {
  return `[#${issue.number}](${issueUrl(config, issue.number)}) ${issue.title}`;
}

// ------------------------------------------------------------------ claim

async function claim(config: Config, gateway: Gateway): Promise<void> {
  const ctx = contextOf(config);

  await gateway.ensureLabels();

  let issues = await gateway.listOpenIssues();
  const reclaimed = await reapStaleLocks(gateway, issues, ctx);
  // The reaper can hand an issue back to `merging`, so the sweep below must see the result.
  if (reclaimed > 0 && !config.dryRun) {
    issues = await gateway.listOpenIssues();
  }

  // A forced issue is a human override; the automatic pull-request sweep stays out of its way.
  const sweep =
    config.forceIssue === undefined
      ? await followMerging(gateway, issues, ctx)
      : { advanced: 0, followUp: undefined };

  if (sweep.followUp !== undefined) {
    const inFlight = issuesWith(issues, config.labels, 'processing');
    if (inFlight.length > 0) {
      core.info(`#${inFlight[0]?.number} is still processing; deferring the pull request follow-up`);
    } else {
      await take(config, gateway, ctx, sweep.followUp.issue, sweep.followUp);
      return;
    }
  }

  if (sweep.advanced > 0 && !config.dryRun) {
    issues = await gateway.listOpenIssues();
  }

  const decision = decide(issues, config.labels, config.forceIssue);

  if (decision.kind === 'busy') {
    core.setOutput('decision', 'busy');
    core.setOutput('issue', '');
    core.notice('Queue is busy; no work started.');
    core.summary.addHeading('issue-runner: busy', 3).addTable([
      [
        { data: 'issue', header: true },
        { data: 'status', header: true },
      ],
      ...decision.issues.map((issue) => [
        link(config, issue),
        config.labels
          .on(issue.labels)
          .map((status) => `\`${config.labels.name(status)}\``)
          .join(', '),
      ]),
    ]);
    await core.summary.write();
    return;
  }

  if (decision.kind === 'idle') {
    if (config.forceIssue !== undefined) {
      throw new Error(`Issue #${config.forceIssue} is not open, so it cannot be claimed.`);
    }
    core.setOutput('decision', 'idle');
    core.setOutput('issue', '');
    core.notice(`Nothing labelled ${config.labels.name('open')}; idling.`);
    core.summary
      .addHeading('issue-runner: idle', 3)
      .addRaw(`No issue carries \`${config.labels.name('open')}\`, so no work was started.`);
    await core.summary.write();
    return;
  }

  await take(config, gateway, ctx, decision.issue);
}

/**
 * Locks an issue and lays out everything the worker needs.
 *
 * The same path serves a fresh issue and a pull request that needs another pass, because
 * they need the same thing from the runner: the lock, the state directory, the outputs.
 * What differs is only what lands in that directory.
 */
async function take(
  config: Config,
  gateway: Gateway,
  ctx: EngineContext,
  issue: IssueView,
  followUp?: FollowUp,
): Promise<void> {
  await gateway.setStatus(issue.number, issue.labels, config.labels.name('processing'));
  await gateway.addComment(
    issue.number,
    `${LOCK_MARKER} run=${config.runId} -->\n` +
      `Claimed by \`issue-runner\` at ${ctx.now.toISOString()} - ` +
      `[run #${config.runId}](${config.runUrl}).` +
      (followUp === undefined ? '' : ` Reason: ${followUp.reason}.`),
  );

  let input: FollowUpInput | undefined;
  if (followUp !== undefined) {
    // The watermark moves before the work, not after. A run that dies must not make the next
    // tick answer the same comment again or spend the same fix attempt twice.
    await gateway.addComment(
      issue.number,
      `${formatPullMarker(followUp.marker)}\n` +
        `\`issue-runner\` picked PR #${followUp.pull.number} back up: ${followUp.reason}.`,
    );

    input = {
      task: followUp.task,
      pull: followUp.pull,
      failedChecks: followUp.failedChecks,
      comments: followUp.comments,
      checksLog:
        followUp.failedChecks.length > 0
          ? await gateway.failedJobLogs(followUp.pull.headSha)
          : '',
    };
  }

  publishWorkerInput(config.stateDir, issue, protocolSource(), input);

  const task = input?.task ?? 'implement';
  core.setOutput('decision', 'claimed');
  core.setOutput('issue', String(issue.number));
  core.setOutput('title', issue.title);
  core.setOutput('task', task);
  core.setOutput('pull', followUp === undefined ? '' : String(followUp.pull.number));
  core.notice(`Claimed #${issue.number} (${task}): ${issue.title}`);
  core.summary
    .addHeading(`issue-runner: claimed #${issue.number} (${task})`, 3)
    .addRaw(link(config, issue));
  await core.summary.write();
}

// ---------------------------------------------------------------- release

async function release(config: Config, gateway: Gateway): Promise<void> {
  if (config.issue === undefined) {
    throw new Error("Input 'issue' is required when mode is 'release'.");
  }

  const declared = readStateFile(config, 'next-status');
  const pull = readStateFile(config, 'pr');
  const pullNumber = pull === undefined || pull === '' ? undefined : Number(pull);

  // Whether a pull request is open decides where a cancelled or failed run puts the issue:
  // back to review, not back to the queue, because the branch already carries the work.
  const pullView =
    pullNumber === undefined ? undefined : await gateway.getPullRequest(pullNumber);
  const outcome = resolveRelease(config.jobStatus, declared, pullView?.state === 'OPEN');
  if (outcome.warning !== undefined) {
    core.warning(`#${config.issue}: ${outcome.warning}`);
  }

  const issue = await gateway.getIssue(config.issue);
  if (issue === undefined) {
    throw new Error(`Issue #${config.issue} could not be read, so it was not released.`);
  }

  const target = config.labels.name(outcome.target);
  await gateway.setStatus(issue.number, issue.labels, target);

  if (outcome.target === 'merging' && pullNumber !== undefined) {
    const existing = parsePullMarker(
      await gateway.findLastMarkerComment(issue.number, PR_MARKER),
    );
    if (existing?.pull === pullNumber) {
      // The claim already recorded this pull request, attempt counter and watermark included.
      // Writing a fresh marker here would reset both and let a failing run retry forever.
      await gateway.addComment(
        issue.number,
        `\`issue-runner\` handed PR #${pullNumber} back to \`${target}\`.`,
      );
    } else {
      await gateway.addComment(
        issue.number,
        `${formatPullMarker({ pull: pullNumber, attempt: 0 })}\n` +
          `\`issue-runner\` moved this to \`${target}\`, tracking #${pullNumber}. ` +
          'The queue stays parked until that pull request is merged or closed.',
      );
    }
  } else {
    await gateway.addComment(
      issue.number,
      `\`issue-runner\` moved this to \`${target}\` after ` +
        `[run #${config.runId}](${config.runUrl}). ${outcome.reason}`,
    );
  }

  if (outcome.target === 'done') {
    await gateway.closeIssue(issue.number);
  }

  core.notice(`#${issue.number} released as ${target}`);
  core.summary.addRaw(`\n\nReleased ${link(config, issue)} as \`${target}\`.`);
  await core.summary.write();
}

// ------------------------------------------------------------------- entry

async function run(): Promise<void> {
  const config = readConfig();
  core.setOutput('state-dir', config.stateDir);

  if (config.dryRun) {
    core.info('Running in dry-run mode: nothing is written back to GitHub.');
  }

  const gateway = new GitHubGateway(config);
  await (config.mode === 'claim' ? claim(config, gateway) : release(config, gateway));
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
