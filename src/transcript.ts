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

export interface StreamEvent {
  type: string;
  subtype?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  message?: { content?: ContentBlock[] };
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

/** One stream line, as either the lines it describes or the raw text if it is not an event. */
export function readLine(line: string): string[] {
  try {
    return linesFor(JSON.parse(line) as StreamEvent);
  } catch {
    // Not every line the CLI writes is an event; keep it rather than lose it.
    return [line];
  }
}
