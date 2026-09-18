import * as fs from 'node:fs';
import * as path from 'node:path';

import type { WorkerTask } from './engine.js';
import type { CommentView, FailedCheck, IssueView, PullView } from './gateway.js';

export const PROTOCOL_NAME = 'PROTOCOL.md';

/**
 * What a follow-up claim adds to the state directory.
 *
 * Every field here was gathered by asking GitHub, not by asking a model: which checks are
 * red, what they printed, what a person wrote. The worker starts with the answers already
 * in hand, which is the difference between a cheap tick and an expensive one.
 */
export interface FollowUpInput {
  task: Exclude<WorkerTask, 'implement'>;
  pull: PullView;
  failedChecks: FailedCheck[];
  checksLog: string;
  comments: CommentView[];
}

/**
 * Where the protocol ships: beside the action, one level up from whatever is executing -
 * `dist/` for the bundle the runner loads, `src/` for a local run. Both resolve to the same
 * file, so no build step has to know about it.
 */
export function protocolSource(): string {
  return path.join(__dirname, '..', 'worker', PROTOCOL_NAME);
}

/**
 * Lays out everything the worker is allowed to see, in one directory.
 *
 * The issue arrives as a file rather than an argument because a title or a body is untrusted
 * input and must never reach a shell. The protocol is copied in beside it for a different
 * reason: it belongs to the runner, not to the repository, and once the action is consumed as
 * `uses: <org>/issue-runner@v1` it no longer sits anywhere the calling workflow could name.
 * The state directory is already the worker's only interface, so the protocol travels through
 * it and the path is the same whether the action is local or published.
 */
export function publishWorkerInput(
  stateDir: string,
  issue: IssueView,
  source: string,
  followUp?: FollowUpInput,
): void {
  if (!fs.existsSync(source)) {
    throw new Error(`The worker protocol is missing at ${source}; this action is incomplete.`);
  }
  fs.mkdirSync(stateDir, { recursive: true });

  const write = (name: string, body: string): void =>
    fs.writeFileSync(path.join(stateDir, name), body);

  fs.copyFileSync(source, path.join(stateDir, PROTOCOL_NAME));
  write('issue.json', JSON.stringify(issue, null, 2));
  write('task', followUp?.task ?? 'implement');

  if (followUp === undefined) return;

  write('pr.json', JSON.stringify(followUp.pull, null, 2));
  write('checks.json', JSON.stringify(followUp.failedChecks, null, 2));
  write('comments.json', JSON.stringify(followUp.comments, null, 2));
  write('checks.log', followUp.checksLog);

  // The release step reads this to know a pull request already exists, so a run that dies
  // hands the issue back to `merging` rather than to the back of the queue.
  write('pr', String(followUp.pull.number));
}
