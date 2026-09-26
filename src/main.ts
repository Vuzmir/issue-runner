import * as fs from 'node:fs';
import * as path from 'node:path';

import * as core from '@actions/core';

import { UsageLimitError, runWorker } from './claude.js';
import { currentBranch, salvagePartialWork } from './salvage.js';
import { type Config, issueUrl, readConfig } from './config.js';
import { GitHubGateway, type CommentView, type Gateway, type IssueView } from './gateway.js';
import {
  LOCK_MARKER,
  PR_MARKER,
  decide,
  findOpenPull,
  followMerging,
  formatPullMarker,
  issuesWith,
  parsePullMarker,
  reapStaleLocks,
  resolveRelease,
  type EngineContext,
  type FollowUp,
} from './engine.js';
import { chooseModel } from './model.js';
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

/** Writes an outcome file the worker did not get to - only used for a salvaged usage-limit
 * run, so `release` below reads the same contract it always does. */
function writeStateFile(config: Config, name: string, value: string): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(path.join(config.stateDir, name), value);
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

  // `followMerging` only walks issues still labelled `merging`; one moved back to `open` by
  // hand - the normal way to retry after `blocked` - falls outside that sweep even though its
  // pull request is still open. Catch it here, before `implement` brands a second branch and
  // pull request onto work that already has one.
  const openPull = await findOpenPull(gateway, decision.issue);
  if (openPull !== undefined) {
    core.warning(
      `#${decision.issue.number} is labelled open but PR #${openPull.number} is already open ` +
        'for it; moving it to merging and running its sweep in the same tick',
    );

    // Committing the relabel before anything else keeps GitHub's real label state ahead of
    // every `setStatus` call below - `followMerging`, and `take` after it, both trust the
    // `current` labels they are handed to know what to remove. Faking `merging` in memory
    // without writing it would leave the real `open` label stale once either of them acts.
    await gateway.setStatus(
      decision.issue.number,
      decision.issue.labels,
      config.labels.name('merging'),
    );
    await gateway.addComment(
      decision.issue.number,
      `\`issue-runner\` found PR #${openPull.number} still open for this issue, so it moved this ` +
        `back to \`${config.labels.name('merging')}\` instead of starting a new implementation.`,
    );

    // The label just written makes this issue's real state match what `followMerging` expects,
    // so the same sweep a `merging` issue gets on every tick can run on it right now instead of
    // waiting out a full tick interval for a comment or a red check that is already sitting
    // there waiting.
    const nowMerging: IssueView = {
      ...decision.issue,
      labels: [
        ...decision.issue.labels.filter((name) => name !== config.labels.name('open')),
        config.labels.name('merging'),
      ],
    };
    const resweep = await followMerging(gateway, [nowMerging], ctx);

    if (resweep.followUp !== undefined) {
      await take(config, gateway, ctx, resweep.followUp.issue, resweep.followUp);
      return;
    }

    core.setOutput('decision', 'idle');
    core.setOutput('issue', '');
    core.notice(`#${decision.issue.number} redirected to its pull request; no fresh implementation started.`);
    core.summary
      .addHeading('issue-runner: redirected', 3)
      .addRaw(`${link(config, decision.issue)} already has PR #${openPull.number} open.`);
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
  let priorComments: CommentView[] = [];
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
  } else {
    // A plain `implement` claim has no pull request yet to carry a watermark, and an issue can
    // go `blocked` and come back `open` - reopened, or just relabeled - with a person's answer
    // sitting in the thread in between. Without this, the worker would only ever see the
    // title and body, as if the issue had never been touched.
    priorComments = await gateway.issueComments(issue.number);
  }

  publishWorkerInput(config.stateDir, issue, protocolSource(), priorComments, input);

  const task = input?.task ?? 'implement';
  const model = chooseModel(issue.labels, config.modelLabelPrefix, config.model);
  if (model.warning !== undefined) core.warning(`#${issue.number} ${model.warning}`);
  if (model.label !== undefined) core.info(`#${issue.number} is labelled \`${model.label}\`; using ${model.model}`);

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

  // Worked in the same process as the claim, rather than as a separate step: there is no
  // longer a job boundary between them, so a failure here is caught rather than left to end
  // the run - the issue still has to be released either way.
  let jobStatus: 'success' | 'failure' | 'rate-limited' = 'success';
  // Read before the worker runs: it is the "never push here directly" branch a salvage below
  // compares against, which is only meaningful against the state the workspace started in.
  const workspace = process.env['GITHUB_WORKSPACE'] ?? process.cwd();
  const initialBranch = currentBranch(workspace);
  try {
    await runWorker({
      issue: issue.number,
      task,
      model: model.model,
      version: config.claudeVersion,
      nodeVersion: config.nodeVersion,
      claudeToken: config.claudeToken,
      githubToken: config.githubToken,
      stateDir: config.stateDir,
    });
  } catch (error: unknown) {
    if (error instanceof UsageLimitError) {
      jobStatus = 'rate-limited';
      core.warning(error.message);

      // The worker never reached Phase 4, but whatever it had written before the limit hit is
      // still sitting in the workspace. Committing it here is the difference between a usage
      // limit costing a requeue and it costing the diff too.
      const salvage = await salvagePartialWork(gateway, {
        cwd: workspace,
        issue,
        task,
        initialBranch,
        existingPull:
          followUp === undefined ? undefined : { number: followUp.pull.number, headRef: followUp.pull.headRef },
        reason: error.message,
        owner: config.owner,
        repo: config.repo,
        githubToken: config.githubToken,
      });
      if (salvage.pull !== undefined) {
        // Same contract the worker itself would have written for `merging` - `release` below
        // does not need to know this came from a salvage rather than a finished session.
        writeStateFile(config, 'next-status', 'merging');
        writeStateFile(config, 'pr', String(salvage.pull.number));
      }
    } else {
      jobStatus = 'failure';
      core.error(error instanceof Error ? error.message : String(error));
    }
  }

  await release(config, gateway, issue.number, jobStatus);

  // The issue is already released and labelled correctly above; failing the run after that is
  // purely so a failed working session stays visible in the Actions UI and to anything
  // watching run status, rather than reporting green on a run that had to fall back to
  // `status:failed` or hand the pull request back unfinished. A usage limit is neither: it is
  // requeued rather than failed, and nobody needs the run flagged red over it.
  if (jobStatus === 'failure') {
    core.setFailed(`Working #${issue.number} failed.`);
  }
}

// ---------------------------------------------------------------- release

async function release(
  config: Config,
  gateway: Gateway,
  issueNumber: number,
  jobStatus: 'success' | 'failure' | 'rate-limited',
): Promise<void> {
  const issue = await gateway.getIssue(issueNumber);
  if (issue === undefined) {
    throw new Error(`Issue #${issueNumber} could not be read, so it was not released.`);
  }

  const declared = readStateFile(config, 'next-status');
  const pull = readStateFile(config, 'pr');
  const pullNumber = pull === undefined || pull === '' ? undefined : Number(pull);

  // Whether a pull request is open decides where a failed run puts the issue: back to review,
  // not back to the queue, because the branch already carries the work. The worker only
  // leaves `pr` behind once it has pushed one, so a run that never got that far - including
  // one that was claimed as `implement` over an issue that already had one - has to fall back
  // to the marker instead of assuming there is nothing to lose.
  const pullView =
    pullNumber === undefined
      ? await findOpenPull(gateway, issue)
      : await gateway.getPullRequest(pullNumber);
  const outcome = resolveRelease(jobStatus, declared, pullView?.state === 'OPEN');
  if (outcome.warning !== undefined) {
    core.warning(`#${issueNumber}: ${outcome.warning}`);
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
  await claim(config, gateway);
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
