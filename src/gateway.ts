import * as core from '@actions/core';
import { getOctokit } from '@actions/github';

import type { Config } from './config.js';
import { STATUS_DEFINITIONS, STATUS_NAMES, type StatusLabels } from './statuses.js';

export interface IssueView {
  number: number;
  title: string;
  labels: string[];
  updatedAt: string;
  body: string;
  url: string;
  author: string;
}

export type PullRequestState = 'MERGED' | 'CLOSED' | 'OPEN';

export interface PullView {
  number: number;
  state: PullRequestState;
  draft: boolean;
  headSha: string;
  headRef: string;
  createdAt: string;
  url: string;
}

/**
 * What the checks on a commit say, reduced to the only four answers the loop acts on.
 * `none` and `pending` both mean "wait"; only `failing` is work.
 */
export type CheckVerdict = 'passing' | 'failing' | 'pending' | 'none';

export interface FailedCheck {
  name: string;
  conclusion: string;
  url: string;
}

export interface ChecksView {
  verdict: CheckVerdict;
  failed: FailedCheck[];
}

export interface CommentView {
  kind: 'comment' | 'review' | 'review-comment';
  author: string;
  createdAt: string;
  body: string;
  url: string;
  /** Review state, for `kind: 'review'` - CHANGES_REQUESTED, APPROVED, COMMENTED. */
  state?: string;
  /** File and line, for `kind: 'review-comment'`. */
  path?: string;
  line?: number;
}

/**
 * Conclusions that mean the commit is broken and someone has to act.
 *
 * `cancelled` and `stale` are deliberately not here: nothing a worker changes in the code
 * fixes them, so the runner waits for a human to re-run rather than spending an attempt.
 */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);

/** Bounds on the log the worker is handed, so a broken build cannot flood its context. */
const MAX_FAILED_RUNS = 2;
const MAX_FAILED_JOBS = 3;
const MAX_LOG_LINES = 300;

/**
 * Whether a comment is an instruction from a person.
 *
 * The runner's own comments have to be excluded or it answers itself forever, and its
 * markers are the reliable way to spot them - the token posts as `github-actions[bot]`
 * here, but a personal access token would not.
 */
function isHuman(type: string | undefined, login: string | undefined, body: string | null | undefined): boolean {
  if (type === 'Bot') return false;
  if ((login ?? '').endsWith('[bot]')) return false;
  return !(body ?? '').includes('issue-runner:');
}

/** The subset of the REST issue payload the engine uses. */
interface RawIssue {
  number: number;
  title: string;
  labels: (string | { name?: string })[];
  updated_at: string;
  body?: string | null;
  html_url: string;
  user?: { login?: string } | null;
}

function toIssueView(issue: RawIssue): IssueView {
  return {
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
    updatedAt: issue.updated_at,
    body: issue.body ?? '',
    url: issue.html_url,
    author: issue.user?.login ?? '',
  };
}

/**
 * Everything the engine needs from GitHub. Kept as an interface so the engine can
 * be exercised against a fake in tests.
 */
export interface Gateway {
  ensureLabels(): Promise<void>;
  listOpenIssues(): Promise<IssueView[]>;
  /** A single issue regardless of whether it is still open. */
  getIssue(issue: number): Promise<IssueView | undefined>;
  setStatus(issue: number, current: readonly string[], target: string): Promise<void>;
  addComment(issue: number, body: string): Promise<void>;
  /** Body of the newest comment starting with `marker`, or undefined. */
  findLastMarkerComment(issue: number, marker: string): Promise<string | undefined>;
  /** When `label` was last applied, or undefined when it cannot be determined. */
  labelAppliedAt(issue: number, label: string): Promise<Date | undefined>;
  workflowRunStatus(runId: string): Promise<string>;
  closeIssue(issue: number): Promise<void>;

  /** The pull request, or undefined when it no longer exists. */
  getPullRequest(pull: number): Promise<PullView | undefined>;
  /** What CI says about a commit. This is the question that replaces asking a model. */
  checksFor(sha: string): Promise<ChecksView>;
  /** The tail of the logs of the jobs that failed on a commit, bounded and best-effort. */
  failedJobLogs(sha: string): Promise<string>;
  /** Comments and reviews a person left on a pull request after `since`. */
  humanCommentsSince(pull: number, since: string): Promise<CommentView[]>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;
  // Secondary rate limits come back as 403 with a documented message.
  if (status === 403) {
    const message = String((error as { message?: string }).message ?? '');
    return /rate limit|secondary rate/i.test(message);
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GitHub returns transient failures often enough that a tick without retries
 * silently loses an hour of the loop.
 */
async function withRetry<T>(what: string, call: () => Promise<T>): Promise<T> {
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      const delay = 1000 * 2 ** (attempt - 1);
      core.warning(`${what} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

function notFoundAs<T>(fallback: T, error: unknown): T {
  if ((error as { status?: number } | undefined)?.status === 404) return fallback;
  throw error;
}

export class GitHubGateway implements Gateway {
  private readonly api: ReturnType<typeof getOctokit>;
  private readonly owner: string;
  private readonly repo: string;
  private readonly labels: StatusLabels;
  private readonly dryRun: boolean;

  constructor(config: Config) {
    this.api = getOctokit(config.token);
    this.owner = config.owner;
    this.repo = config.repo;
    this.labels = config.labels;
    this.dryRun = config.dryRun;
  }

  private get base(): { owner: string; repo: string } {
    return { owner: this.owner, repo: this.repo };
  }

  private skip(description: string): boolean {
    if (this.dryRun) {
      core.info(`dry-run: skipping ${description}`);
      return true;
    }
    return false;
  }

  async ensureLabels(): Promise<void> {
    const existing = await withRetry('list labels', () =>
      this.api.paginate(this.api.rest.issues.listLabelsForRepo, { ...this.base, per_page: 100 }),
    );
    const present = new Set(existing.map((label) => label.name));

    for (const status of STATUS_NAMES) {
      const name = this.labels.name(status);
      if (present.has(name)) continue;
      if (this.skip(`creating label ${name}`)) continue;
      const definition = STATUS_DEFINITIONS[status];
      core.info(`creating missing label: ${name}`);
      await withRetry(`create label ${name}`, () =>
        this.api.rest.issues.createLabel({
          ...this.base,
          name,
          color: definition.color,
          description: definition.description,
        }),
      );
    }
  }

  async listOpenIssues(): Promise<IssueView[]> {
    const issues = await withRetry('list open issues', () =>
      this.api.paginate(this.api.rest.issues.listForRepo, {
        ...this.base,
        state: 'open',
        per_page: 100,
      }),
    );

    // The issues endpoint returns pull requests too; they are not work items.
    return issues.filter((issue) => issue.pull_request === undefined).map(toIssueView);
  }

  async getIssue(issue: number): Promise<IssueView | undefined> {
    try {
      const { data } = await withRetry(`read #${issue}`, () =>
        this.api.rest.issues.get({ ...this.base, issue_number: issue }),
      );
      return toIssueView(data);
    } catch (error) {
      return notFoundAs(undefined, error);
    }
  }

  async setStatus(issue: number, current: readonly string[], target: string): Promise<void> {
    const stale = this.labels
      .on(current)
      .map((status) => this.labels.name(status))
      .filter((name) => name !== target);
    const alreadyThere = current.includes(target);

    if (stale.length === 0 && alreadyThere) {
      core.info(`#${issue} already at ${target}`);
      return;
    }
    if (this.skip(`moving #${issue} to ${target}`)) return;

    for (const name of stale) {
      await withRetry(`remove ${name} from #${issue}`, () =>
        this.api.rest.issues
          .removeLabel({ ...this.base, issue_number: issue, name })
          // A label that is already gone is the state we wanted anyway.
          .catch((error: unknown) => notFoundAs(undefined, error)),
      );
    }
    if (!alreadyThere) {
      await withRetry(`add ${target} to #${issue}`, () =>
        this.api.rest.issues.addLabels({ ...this.base, issue_number: issue, labels: [target] }),
      );
    }
    core.info(`#${issue} -> ${target}`);
  }

  async addComment(issue: number, body: string): Promise<void> {
    if (this.skip(`commenting on #${issue}`)) return;
    await withRetry(`comment on #${issue}`, () =>
      this.api.rest.issues.createComment({ ...this.base, issue_number: issue, body }),
    );
  }

  async findLastMarkerComment(issue: number, marker: string): Promise<string | undefined> {
    const comments = await withRetry(`list comments on #${issue}`, () =>
      this.api.paginate(this.api.rest.issues.listComments, {
        ...this.base,
        issue_number: issue,
        per_page: 100,
      }),
    );
    for (let i = comments.length - 1; i >= 0; i--) {
      const body = comments[i]?.body;
      if (body?.startsWith(marker)) return body;
    }
    return undefined;
  }

  async labelAppliedAt(issue: number, label: string): Promise<Date | undefined> {
    const events = await withRetry(`list events on #${issue}`, () =>
      this.api.paginate(this.api.rest.issues.listEvents, {
        ...this.base,
        issue_number: issue,
        per_page: 100,
      }),
    );
    // The timeline is a union of event shapes; only the labelled ones carry `label`.
    type LabelEvent = { event: string; created_at: string; label?: { name?: string } };
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i] as LabelEvent | undefined;
      if (event?.event === 'labeled' && event.label?.name === label) {
        return new Date(event.created_at);
      }
    }
    return undefined;
  }

  async workflowRunStatus(runId: string): Promise<string> {
    const id = Number(runId);
    if (!Number.isInteger(id) || id <= 0) return 'missing';
    try {
      const run = await withRetry(`read run ${runId}`, () =>
        this.api.rest.actions.getWorkflowRun({ ...this.base, run_id: id }),
      );
      return run.data.status ?? 'missing';
    } catch (error) {
      return notFoundAs('missing', error);
    }
  }

  async getPullRequest(pull: number): Promise<PullView | undefined> {
    try {
      const { data } = await withRetry(`read pull request #${pull}`, () =>
        this.api.rest.pulls.get({ ...this.base, pull_number: pull }),
      );
      return {
        number: data.number,
        state: data.merged_at !== null ? 'MERGED' : data.state === 'closed' ? 'CLOSED' : 'OPEN',
        draft: data.draft ?? false,
        headSha: data.head.sha,
        headRef: data.head.ref,
        createdAt: data.created_at,
        url: data.html_url,
      };
    } catch (error) {
      return notFoundAs(undefined, error);
    }
  }

  async checksFor(sha: string): Promise<ChecksView> {
    const runs = await withRetry(`list check runs for ${sha}`, () =>
      this.api.paginate(this.api.rest.checks.listForRef, { ...this.base, ref: sha, per_page: 100 }),
    );

    const failed: FailedCheck[] = [];
    let pending = false;
    let seen = false;

    for (const run of runs) {
      seen = true;
      if (run.status !== 'completed') {
        pending = true;
        continue;
      }
      if (run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion)) {
        failed.push({
          name: run.name,
          conclusion: run.conclusion,
          url: run.html_url ?? run.details_url ?? '',
        });
      }
    }

    // Older integrations report through commit statuses rather than check runs.
    const { data: combined } = await withRetry(`read commit status for ${sha}`, () =>
      this.api.rest.repos.getCombinedStatusForRef({ ...this.base, ref: sha }),
    );
    for (const status of combined.statuses) {
      seen = true;
      if (status.state === 'pending') pending = true;
      if (status.state === 'failure' || status.state === 'error') {
        failed.push({ name: status.context, conclusion: status.state, url: status.target_url ?? '' });
      }
    }

    if (!seen) return { verdict: 'none', failed: [] };
    // A failure is worth acting on even while something else is still running: the commit is
    // already known to be broken, and waiting only delays the fix by an hour.
    if (failed.length > 0) return { verdict: 'failing', failed };
    return { verdict: pending ? 'pending' : 'passing', failed: [] };
  }

  async failedJobLogs(sha: string): Promise<string> {
    const parts: string[] = [];
    try {
      const { data } = await withRetry(`list runs for ${sha}`, () =>
        this.api.rest.actions.listWorkflowRunsForRepo({ ...this.base, head_sha: sha, per_page: 20 }),
      );
      const broken = data.workflow_runs.filter((run) => run.conclusion === 'failure');

      let taken = 0;
      for (const run of broken.slice(0, MAX_FAILED_RUNS)) {
        const jobs = await withRetry(`list jobs for run ${run.id}`, () =>
          this.api.paginate(this.api.rest.actions.listJobsForWorkflowRun, {
            ...this.base,
            run_id: run.id,
            per_page: 100,
          }),
        );
        for (const job of jobs.filter((j) => j.conclusion === 'failure')) {
          if (taken >= MAX_FAILED_JOBS) break;
          taken++;
          const log = await this.jobLogTail(job.id);
          parts.push(`===== ${run.name ?? 'workflow'} / ${job.name} =====\n${log}`);
        }
      }
    } catch (error) {
      // A missing log degrades the worker's input; it does not invalidate the decision that
      // brought us here, which came from the check conclusions and not from this.
      core.warning(`Could not collect failing job logs: ${String(error)}`);
    }
    return parts.join('\n\n');
  }

  private async jobLogTail(jobId: number): Promise<string> {
    try {
      const response = await withRetry(`download logs for job ${jobId}`, () =>
        this.api.rest.actions.downloadJobLogsForWorkflowRun({ ...this.base, job_id: jobId }),
      );
      const text = String(response.data);
      const lines = text.split(/\r?\n/);
      const tail = lines.slice(-MAX_LOG_LINES);
      const dropped = lines.length - tail.length;
      return (dropped > 0 ? `... ${dropped} earlier lines omitted ...\n` : '') + tail.join('\n');
    } catch (error) {
      return `(log unavailable: ${String(error)})`;
    }
  }

  async humanCommentsSince(pull: number, since: string): Promise<CommentView[]> {
    const after = new Date(since).getTime();
    const found: CommentView[] = [];

    const conversation = await withRetry(`list comments on #${pull}`, () =>
      this.api.paginate(this.api.rest.issues.listComments, {
        ...this.base,
        issue_number: pull,
        per_page: 100,
      }),
    );
    for (const comment of conversation) {
      if (!isHuman(comment.user?.type, comment.user?.login, comment.body)) continue;
      if (new Date(comment.created_at).getTime() <= after) continue;
      found.push({
        kind: 'comment',
        author: comment.user?.login ?? '',
        createdAt: comment.created_at,
        body: comment.body ?? '',
        url: comment.html_url,
      });
    }

    const reviews = await withRetry(`list reviews on #${pull}`, () =>
      this.api.paginate(this.api.rest.pulls.listReviews, {
        ...this.base,
        pull_number: pull,
        per_page: 100,
      }),
    );
    for (const review of reviews) {
      if (!isHuman(review.user?.type, review.user?.login, review.body)) continue;
      // A review still being drafted has no `submitted_at`, and its inline comments are not
      // published either - GitHub shows them to their author alone until Submit review is
      // pressed, so no token the runner holds can see them. Nothing to answer yet.
      const at = review.submitted_at;
      if (at == null || new Date(at).getTime() <= after) continue;
      // An approval with nothing written carries no instruction; a change request always does.
      if ((review.body ?? '').trim() === '' && review.state !== 'CHANGES_REQUESTED') continue;
      found.push({
        kind: 'review',
        author: review.user?.login ?? '',
        createdAt: at,
        body: review.body ?? '',
        url: review.html_url,
        state: review.state,
      });
    }

    const inline = await withRetry(`list review comments on #${pull}`, () =>
      this.api.paginate(this.api.rest.pulls.listReviewComments, {
        ...this.base,
        pull_number: pull,
        per_page: 100,
      }),
    );
    for (const comment of inline) {
      if (!isHuman(comment.user.type, comment.user.login, comment.body)) continue;
      if (new Date(comment.created_at).getTime() <= after) continue;
      found.push({
        kind: 'review-comment',
        author: comment.user.login,
        createdAt: comment.created_at,
        body: comment.body,
        url: comment.html_url,
        path: comment.path,
        line: comment.line ?? comment.original_line ?? undefined,
      });
    }

    return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async closeIssue(issue: number): Promise<void> {
    if (this.skip(`closing #${issue}`)) return;
    await withRetry(`close #${issue}`, () =>
      this.api.rest.issues.update({
        ...this.base,
        issue_number: issue,
        state: 'closed',
        state_reason: 'completed',
      }),
    );
  }
}
