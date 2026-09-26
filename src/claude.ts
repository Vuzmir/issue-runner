// The Claude adapter: hands a claimed issue to the Claude CLI and lets the protocol the
// loop left in the state directory drive everything else.
//
// This is a separate module from the claim/release flow in main.ts because the two answer
// different questions - `issue-runner` decides *whether* there is work, this decides *how*
// it gets done - but both run in the same process and the same bundle, so main.ts calls
// `runWorker` directly rather than starting anything.
//
// Spawning the CLI with an argument array rather than a command line means no shell anywhere
// parses the prompt, and nothing here has to be quoted for one.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as core from '@actions/core';

import type { WorkerTask } from './engine.js';
import { install } from './install.js';
import { updateNote } from './note.js';
import { ensureNode } from './node.js';
import { isCapacityFailure, lineReader, linesFor, parseLine, type StreamEvent } from './transcript.js';
import { USAGE_MARKER, addRun, lastRunFrom, parseTotals, usageNote, type Limits } from './usage.js';

/** A runner account has no git identity of its own, and `git commit` refuses without one.
 * Exported so a salvage commit made outside the worker's own session signs the same way. */
export const GIT_NAME = 'issue-runner';
export const GIT_EMAIL = 'issue-runner@users.noreply.github.com';

/**
 * Thrown instead of a plain `Error` when the CLI's exit is a Claude usage/rate limit rather
 * than a real failure - so the caller can requeue the issue instead of marking it `failed`.
 */
export class UsageLimitError extends Error {}

export interface WorkerParams {
  issue: number;
  task: WorkerTask;
  model: string;
  version: string;
  nodeVersion: string;
  claudeToken: string;
  githubToken: string;
  stateDir: string;
}

export async function runWorker(params: WorkerParams): Promise<void> {
  const { issue, task, model, githubToken, claudeToken } = params;

  // Forward slashes throughout. The protocol hands the worker shell snippets like
  // `cat "$STATE_DIR/task"`, and a separator the shell reads as an escape character turns
  // those into silent nonsense. A no-op wherever the separator is already `/`.
  const stateDir = params.stateDir.replace(/\\/g, '/');

  const protocol = path.join(stateDir, 'PROTOCOL.md');
  if (!fs.existsSync(protocol)) {
    throw new Error(`No protocol at ${protocol}; the worker must run on a claim's state-dir.`);
  }

  // Fail before spending a session on work that cannot be handed over. The branch is pushed
  // and the pull request opened with this token rather than the workflow's own, because many
  // repositories forbid Actions from opening pull requests at all - and one opened by
  // GITHUB_TOKEN starts no workflows, which would leave the loop waiting forever on checks
  // that never run.
  if (githubToken === '') {
    throw new Error(
      'Set github-token to a token belonging to a person or an app; many repositories forbid ' +
        'Actions from opening pull requests with the default token.',
    );
  }
  if (claudeToken === '' && (process.env['ANTHROPIC_API_KEY'] ?? '') === '') {
    throw new Error('Set claude-token, or ANTHROPIC_API_KEY in the step environment; the CLI cannot authenticate.');
  }

  // Before the prompt is built, so a runner that cannot reach the download service says so
  // rather than after a claim has already been announced.
  const executable = await install(params.version);

  // A skill's own script is the CLI's business, not ours - but if the shell it runs from has
  // no `node`, every one of them fails alike. Installing it here, ahead of the session, means
  // that failure never happens instead of being caught and worked around mid-session.
  await ensureNode(params.nodeVersion);

  core.notice(`Working #${issue} (${task}) with Claude ${model}`);

  const args = [
    '--print',
    `Read ${stateDir}/PROTOCOL.md and follow it. The claimed issue is ${stateDir}/issue.json.`,
    '--model',
    model,
    // Nobody is there to answer a prompt, and the worker legitimately needs to edit files,
    // run the repository's tests, and drive git and gh. An allowlist wide enough to cover
    // that is not meaningfully narrower, and it fails in a far more confusing way - as a
    // denied tool call the worker then tries to work around.
    '--permission-mode',
    'bypassPermissions',
    // The state directory is under RUNNER_TEMP, outside the checkout, so the CLI's file
    // tools cannot reach the protocol without being told about it.
    '--add-dir',
    stateDir,
    // This is one non-interactive turn with no session after it: nothing here will ever
    // read a scheduled wake-up, so the tool has no legitimate use and only invites the
    // mistake the protocol warns against - ending the turn to "check back later" on
    // something nothing is going to check.
    '--disallowed-tools',
    'ScheduleWakeup',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  // Everything else passes through untouched, so whatever a particular machine needs to make
  // the CLI work there - a CLAUDE_CODE_* setting, a proxy, a PATH entry - stays a property
  // of that runner instead of becoming an input here.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STATE_DIR: stateDir,
    GH_TOKEN: githubToken,
    GIT_AUTHOR_NAME: GIT_NAME,
    GIT_AUTHOR_EMAIL: GIT_EMAIL,
    GIT_COMMITTER_NAME: GIT_NAME,
    GIT_COMMITTER_EMAIL: GIT_EMAIL,
  };
  if (claudeToken !== '') env['CLAUDE_CODE_OAUTH_TOKEN'] = claudeToken;

  const worker = spawn(executable, args, {
    cwd: process.env['GITHUB_WORKSPACE'],
    env,
    windowsHide: true,
    // Nothing is ever going to write to the worker's stdin. Saying so costs nothing; leaving
    // it an open pipe makes the CLI wait several seconds for input that cannot arrive.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // The stream is read once, for two purposes: the Actions log, and what the session spent.
  // The rate limit is kept at both ends - the CLI reports it from the first response onwards,
  // so the first and last readings bracket what this run consumed of the window.
  let result: StreamEvent | undefined;
  const limits: Limits = { before: undefined, after: undefined };

  worker.stdout.setEncoding('utf8');
  worker.stdout.on(
    'data',
    lineReader((line) => {
      const event = parseLine(line);
      if (event === undefined) {
        // Not every line the CLI writes is an event; print it rather than lose it.
        core.info(line);
        return;
      }
      for (const text of linesFor(event)) core.info(text);
      if (event.type === 'result') result = event;
      if (event.rate_limit_info !== undefined) {
        limits.before ??= event.rate_limit_info;
        limits.after = event.rate_limit_info;
      }
    }),
  );
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', (chunk: string) => process.stderr.write(chunk));

  const code = await new Promise<number | null>((resolve, reject) => {
    worker.on('error', (error: NodeJS.ErrnoException) =>
      reject(new Error(`Could not start ${executable}: ${error.message}`)),
    );
    worker.on('close', resolve);
  });

  const written = path.join(stateDir, 'next-status');
  const status = fs.existsSync(written) ? fs.readFileSync(written, 'utf8').trim() : '';
  const capacityFailure = code !== 0 && isCapacityFailure(result);
  // What the release step is about to do with this run, said in its own vocabulary: a run
  // that hit a usage limit is requeued rather than failed, a run that died some other way is
  // `failed`, and one that wrote nothing parks at `blocked`.
  const outcome = capacityFailure ? 'rate-limited' : code !== 0 ? 'failed' : status === '' ? 'blocked' : status;

  // A failed run is exactly the one whose cost you want to see, so this comes before the
  // exit code is acted on - and it is reported rather than thrown, because losing the note
  // must not turn a finished pull request into `status:failed`.
  if (result !== undefined) {
    const session = result;
    try {
      await updateNote(githubToken, issue, USAGE_MARKER, (previous) =>
        usageNote(addRun(parseTotals(previous), session), lastRunFrom(session, limits, task, outcome)),
      );
    } catch (error: unknown) {
      core.warning(`Could not update the usage note on #${issue}: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (capacityFailure) {
    throw new UsageLimitError(
      `The Claude CLI hit a usage limit rather than failing: ${(result?.result ?? '').trim() || `exit ${code}`}`,
    );
  }
  if (code !== 0) throw new Error(`The Claude CLI exited with ${code}.`);

  // Not an error - the release step turns a missing outcome into status:blocked on purpose.
  // Saying so here is what makes that label understandable an hour later.
  if (status === '') core.warning('The worker wrote no next-status; the issue will park at blocked.');
  else core.notice(`#${issue} -> ${status}`);
}
