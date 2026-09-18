// The Claude adapter: hands a claimed issue to the Claude CLI and lets the protocol the
// loop left in the state directory drive everything else.
//
// This is a second action rather than a mode of the first, because the two answer different
// questions. `issue-runner` decides *whether* there is work; this decides *who does it*.
// Nothing in src/main.ts imports anything here, and that is the point: a project can adopt
// the queue with a different worker, or with none, and this file simply goes unused.
//
// It is a JavaScript action for the same reason the loop is - it runs on the Node every
// Actions runner already embeds, so it needs no shell and assumes no platform. Spawning the
// CLI with an argument array rather than a command line carries that one step further: no
// shell anywhere parses the prompt, and nothing here has to be quoted for one.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as core from '@actions/core';

import { lineReader, readLine } from './transcript.js';

/** A runner account has no git identity of its own, and `git commit` refuses without one. */
const GIT_NAME = 'issue-runner';
const GIT_EMAIL = 'issue-runner@users.noreply.github.com';

async function run(): Promise<void> {
  const issue = core.getInput('issue', { required: true });
  const task = core.getInput('task', { required: true });
  const model = core.getInput('model', { required: true });

  // Forward slashes throughout. The protocol hands the worker shell snippets like
  // `cat "$STATE_DIR/task"`, and a separator the shell reads as an escape character turns
  // those into silent nonsense. A no-op wherever the separator is already `/`.
  const stateDir = core.getInput('state-dir', { required: true }).replace(/\\/g, '/');

  const protocol = path.join(stateDir, 'PROTOCOL.md');
  if (!fs.existsSync(protocol)) {
    throw new Error(`No protocol at ${protocol}; this step must run after a claim, on that claim's state-dir.`);
  }

  // Fail before spending a session on work that cannot be handed over. The branch is pushed
  // and the pull request opened with this token rather than the workflow's own, because many
  // repositories forbid Actions from opening pull requests at all - and one opened by
  // GITHUB_TOKEN starts no workflows, which would leave the loop waiting forever on checks
  // that never run.
  const githubToken = core.getInput('github-token', { required: true });
  const claudeToken = core.getInput('claude-token');
  if (claudeToken === '' && (process.env['ANTHROPIC_API_KEY'] ?? '') === '') {
    throw new Error('Set claude-token, or ANTHROPIC_API_KEY in the step environment; the CLI cannot authenticate.');
  }

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

  const worker = spawn('claude', args, { cwd: process.env['GITHUB_WORKSPACE'], env, windowsHide: true });

  worker.stdout.setEncoding('utf8');
  worker.stdout.on(
    'data',
    lineReader((line) => {
      for (const text of readLine(line)) core.info(text);
    }),
  );
  worker.stderr.setEncoding('utf8');
  worker.stderr.on('data', (chunk: string) => process.stderr.write(chunk));

  const code = await new Promise<number | null>((resolve, reject) => {
    worker.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new Error(
              "No `claude` executable on this runner's PATH. It has to be one the runner account can" +
                ' execute directly: a wrapper script that only a shell can launch is not spawnable here.',
            )
          : error,
      ),
    );
    worker.on('close', resolve);
  });

  if (code !== 0) throw new Error(`The Claude CLI exited with ${code}.`);

  // Not an error - the release step turns a missing outcome into status:blocked on purpose.
  // Saying so here is what makes that label understandable an hour later.
  const outcome = path.join(stateDir, 'next-status');
  const status = fs.existsSync(outcome) ? fs.readFileSync(outcome, 'utf8').trim() : '';
  if (status === '') core.warning('The worker wrote no next-status; the issue will park at blocked.');
  else core.notice(`#${issue} -> ${status}`);
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
