/**
 * The queue's state machine.
 *
 * An issue with no status label is backlog and invisible to the runner.
 * Labelling it `open` is the explicit act that admits it into the queue, which
 * doubles as the authorization boundary: only someone who can label an issue can
 * hand it to the worker.
 */

export const STATUS_NAMES = ['open', 'processing', 'merging', 'blocked', 'failed', 'done'] as const;

export type Status = (typeof STATUS_NAMES)[number];

/** Statuses that hold the queue: while any issue is in one, nothing new starts. */
export const BUSY_STATUSES: readonly Status[] = ['processing', 'merging'];

export const STATUS_DEFINITIONS: Record<Status, { color: string; description: string }> = {
  open: { color: '0E8A16', description: 'Queued: the issue runner may pick this up' },
  processing: { color: 'FBCA04', description: 'In flight: claimed by an issue-runner run' },
  merging: { color: '1D76DB', description: 'Work is done, a pull request is awaiting review/merge' },
  blocked: { color: 'B60205', description: 'Needs a human decision; the runner will skip it' },
  failed: { color: 'D93F0B', description: 'The last run failed; needs a human before requeueing' },
  done: { color: '6F42C1', description: 'Completed and merged' },
};

export function isStatus(value: string): value is Status {
  return (STATUS_NAMES as readonly string[]).includes(value);
}

/** Translates between short status names and the prefixed labels on GitHub. */
export class StatusLabels {
  constructor(private readonly prefix: string) {}

  name(status: Status): string {
    return `${this.prefix}${status}`;
  }

  /** The status a label encodes, or undefined when the label is not ours. */
  parse(label: string): Status | undefined {
    if (!label.startsWith(this.prefix)) return undefined;
    const rest = label.slice(this.prefix.length);
    return isStatus(rest) ? rest : undefined;
  }

  all(): string[] {
    return STATUS_NAMES.map((status) => this.name(status));
  }

  /** Every status label currently on an issue. */
  on(labels: readonly string[]): Status[] {
    return labels.map((label) => this.parse(label)).filter((s): s is Status => s !== undefined);
  }

  isBusy(labels: readonly string[]): boolean {
    return this.on(labels).some((status) => BUSY_STATUSES.includes(status));
  }
}
