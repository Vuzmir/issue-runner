// What an issue has cost, kept as one comment that every run edits rather than a new comment
// per run. An issue normally gets worked more than once - a fix attempt, a review round - and
// a note showing only the latest run would quietly drop what the earlier ones spent.
//
// The running total lives in the marker line, the same way the loop carries pull request
// state, so the note can be rebuilt from itself without keeping state anywhere else. Only
// that one line is ever parsed: prose underneath it cannot forge a number.

import type { RateLimitInfo, StreamEvent } from './transcript.js';

export const USAGE_MARKER = '<!-- issue-runner:usage';

const RUNS_PATTERN = /\bruns=(\d+)/;
const COST_PATTERN = /\bcost=([\d.]+)/;
const IN_PATTERN = /\bin=(\d+)/;
const OUT_PATTERN = /\bout=(\d+)/;
const CACHE_WRITE_PATTERN = /\bcw=(\d+)/;
const CACHE_READ_PATTERN = /\bcr=(\d+)/;

export interface Totals {
  runs: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number;
}

export interface LastRun {
  task: string;
  outcome: string;
  turns: number;
  durationMs: number;
  models: string[];
  fiveHour: number | undefined;
  sevenDay: number | undefined;
}

const NOTHING: Totals = { runs: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 };

function number(body: string, pattern: RegExp): number {
  const found = pattern.exec(body)?.[1];
  const value = found === undefined ? NaN : Number(found);
  return Number.isFinite(value) ? value : 0;
}

/** The totals a previous note carried, or zeroes when this is the issue's first run. */
export function parseTotals(body: string | undefined): Totals {
  const marker = body?.split('\n').find((line) => line.startsWith(USAGE_MARKER));
  if (marker === undefined) return { ...NOTHING };
  return {
    runs: number(marker, RUNS_PATTERN),
    input: number(marker, IN_PATTERN),
    output: number(marker, OUT_PATTERN),
    cacheWrite: number(marker, CACHE_WRITE_PATTERN),
    cacheRead: number(marker, CACHE_READ_PATTERN),
    costUsd: number(marker, COST_PATTERN),
  };
}

export function formatTotals(totals: Totals): string {
  return (
    `${USAGE_MARKER} runs=${totals.runs} cost=${totals.costUsd.toFixed(4)}` +
    ` in=${totals.input} out=${totals.output} cw=${totals.cacheWrite} cr=${totals.cacheRead} -->`
  );
}

/** Everything the CLI reported about one session, folded into the issue's running total. */
export function addRun(previous: Totals, result: StreamEvent): Totals {
  const models = Object.values(result.modelUsage ?? {});
  const sum = (pick: (usage: (typeof models)[number]) => number | undefined): number =>
    models.reduce((total, usage) => total + (pick(usage) ?? 0), 0);

  return {
    runs: previous.runs + 1,
    input: previous.input + sum((usage) => usage.inputTokens),
    output: previous.output + sum((usage) => usage.outputTokens),
    cacheWrite: previous.cacheWrite + sum((usage) => usage.cacheCreationInputTokens),
    cacheRead: previous.cacheRead + sum((usage) => usage.cacheReadInputTokens),
    // The authoritative figure, rather than re-adding the per-model ones and drifting.
    costUsd: previous.costUsd + (result.total_cost_usd ?? 0),
  };
}

/** The models a session actually used - which is more than the one that was asked for. */
export function modelsIn(result: StreamEvent): string[] {
  const named = Object.entries(result.modelUsage ?? {}).map(([key, usage]) => usage.canonicalModel ?? key);
  return [...new Set(named)].sort();
}

/** The rate limit arrives on its own events, not on the result, so it is passed in. */
export function lastRunFrom(
  result: StreamEvent,
  limits: RateLimitInfo | undefined,
  task: string,
  outcome: string,
): LastRun {
  const windows = limits?.unifiedWindows;
  return {
    task,
    outcome,
    turns: result.num_turns ?? 0,
    durationMs: result.duration_ms ?? 0,
    models: modelsIn(result),
    fiveHour: windows?.five_hour?.utilization,
    sevenDay: windows?.seven_day?.utilization,
  };
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function percent(utilization: number | undefined): string | undefined {
  return utilization === undefined ? undefined : `${Math.round(utilization * 100)}%`;
}

export function usageNote(totals: Totals, last: LastRun): string {
  const limits = [
    percent(last.fiveHour) === undefined ? undefined : `5-hour ${percent(last.fiveHour)}`,
    percent(last.sevenDay) === undefined ? undefined : `7-day ${percent(last.sevenDay)}`,
  ].filter((part): part is string => part !== undefined);

  const lines = [
    formatTotals(totals),
    '### What this issue has cost',
    '',
    '| tokens | |',
    '| --- | --: |',
    `| input | ${count(totals.input)} |`,
    `| output | ${count(totals.output)} |`,
    `| cache write | ${count(totals.cacheWrite)} |`,
    `| cache read | ${count(totals.cacheRead)} |`,
    '',
    `Over **${totals.runs} run${totals.runs === 1 ? '' : 's'}**, a list-price equivalent of` +
      ` **$${totals.costUsd.toFixed(2)}**. That is what the same tokens would cost through the API;` +
      ' work done on a subscription plan is not billed at that rate, and the limit it actually' +
      ' spends is the rate-limit window below.',
    '',
    `Last run · \`${last.task}\` → \`${last.outcome}\` · ${last.turns} turns · ${duration(last.durationMs)}` +
      (last.models.length === 0 ? '' : ` · ${last.models.join(', ')}`),
  ];

  if (limits.length > 0) lines.push(`Rate limit after it · ${limits.join(' · ')}`);

  return lines.join('\n');
}
