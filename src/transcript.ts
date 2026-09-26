// Turning the CLI's NDJSON stream into the handful of lines worth keeping in an Actions log.
//
// Separate from claude.ts so it can be tested: that file is an entry point and runs itself
// on import. Nothing here talks to the runner or the process - it is a pure reading of the
// stream, which is the part that has a shape worth asserting on.

/** One line per tool call keeps a run readable; the full transcript is the CLI's own. */
const SUMMARY_LENGTH = 200;

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

/** What one model contributed to a session. The CLI reaches for more than the one it was
 * asked for, so this is keyed by model and never has exactly one entry. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUSD?: number;
  /** `claude-sonnet-5` rather than the dated build the key names. */
  canonicalModel?: string;
}

/** Utilization is a fraction of the window, not a percentage. */
export interface RateLimitInfo {
  unifiedWindows?: {
    five_hour?: { utilization?: number };
    seven_day?: { utilization?: number };
  };
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  modelUsage?: Record<string, ModelUsage>;
  rate_limit_info?: RateLimitInfo;
  message?: { content?: ContentBlock[] };
  /** Set on a `result` event whose turn ended in an error - which `subtype` alone does not
   * reliably say: the CLI is known to report `subtype: "success"` on API-level failures. */
  is_error?: boolean;
  /** The CLI's own prose summary of what happened, carried on `result` events. On a hard API
   * failure this is the error text itself rather than anything the model wrote. */
  result?: string;
  /** Present on newer CLI builds when a `result` event ends on an API error; not to be
   * confused with `subtype`, which the CLI does not yet derive from it. */
  terminal_reason?: string;
  /** The HTTP status the API rejected the request with, when `terminal_reason` is `api_error`. */
  api_error_status?: number;
}

/** HTTP statuses the API uses for "try again later" rather than "this request is wrong". */
const RETRYABLE_API_STATUSES = new Set([429, 503, 529]);

/**
 * Known-bad but not-our-fault: the account ran out of usage window, or the API is rate
 * limiting or overloaded. None of that is something a retry-later run can fix by trying
 * harder, and none of it is the sort of bug a person needs to look at before requeueing.
 *
 * The CLI's own `subtype` cannot be trusted for this - it is documented to report
 * `"success"` on exactly this class of failure (anthropics/claude-code#79500) - so this
 * reads `is_error`, the newer `terminal_reason`/`api_error_status` pair, and, failing both,
 * the prose the CLI leaves in `result`.
 */
export function isCapacityFailure(event: StreamEvent | undefined): boolean {
  if (event === undefined || event.type !== 'result' || event.is_error !== true) return false;
  if (event.terminal_reason === 'api_error' && RETRYABLE_API_STATUSES.has(event.api_error_status ?? 0)) {
    return true;
  }
  const text = event.result ?? '';
  return /^Claude AI usage limit reached\b/i.test(text) || /^API Error: (Rate limit reached|Overloaded)\b/i.test(text);
}

export function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_LENGTH ? `${flat.slice(0, SUMMARY_LENGTH)}...` : flat;
}

/** The lines one event is worth. Returning them rather than printing them is what makes
 * the shape of a run assertable without capturing a console. */
export function linesFor(event: StreamEvent): string[] {
  switch (event.type) {
    case 'system':
      if (event.subtype !== 'init') return [];
      return [`[init] model=${event.model} permissions=${event.permissionMode} cwd=${event.cwd}`];
    case 'assistant':
      return (event.message?.content ?? []).flatMap((block) => {
        if (block.type === 'text' && (block.text ?? '').trim() !== '') return [block.text as string];
        if (block.type === 'tool_use') return [`  -> ${block.name} ${summarize(block.input)}`];
        return [];
      });
    case 'user':
      // Only failures: a successful tool result is already implied by what comes next.
      return (event.message?.content ?? []).flatMap((block) =>
        block.type === 'tool_result' && block.is_error === true ? [`  !! ${summarize(block.content)}`] : [],
      );
    case 'result':
      return [
        `[result] ${event.subtype} turns=${event.num_turns}` +
          ` ${Math.round((event.duration_ms ?? 0) / 1000)}s` +
          ` $${(event.total_cost_usd ?? 0).toFixed(2)}`,
      ];
    default:
      // rate_limit_event, and whatever the CLI adds later: not worth a line.
      return [];
  }
}

/**
 * Reassembles lines from stdout chunks, which split wherever the pipe felt like it. A chunk
 * boundary landing mid-line is the normal case, not the edge case.
 */
export function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let pending = '';
  return (chunk: string): void => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim() !== '') onLine(line);
  };
}

/**
 * One stream line as an event, or undefined when the CLI printed something that is not one.
 * Parsing is separate from `linesFor` because the caller wants the event too, not only what
 * it reads as - the run's cost arrives on the same events the log is built from.
 */
export function parseLine(line: string): StreamEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as StreamEvent;
  } catch {
    return undefined;
  }
}
