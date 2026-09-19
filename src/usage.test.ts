import { describe, expect, it } from 'vitest';

import type { StreamEvent } from './transcript.js';
import { USAGE_MARKER, addRun, formatTotals, lastRunFrom, modelsIn, parseTotals, usageNote } from './usage.js';

/** Shaped like a real one: the CLI reports per model, and reaches for more than it was asked. */
const result: StreamEvent = {
  type: 'result',
  subtype: 'success',
  num_turns: 23,
  duration_ms: 252_000,
  total_cost_usd: 2.14,
  modelUsage: {
    'claude-sonnet-5': {
      inputTokens: 1_204,
      outputTokens: 18_430,
      cacheCreationInputTokens: 112_900,
      cacheReadInputTokens: 1_840_220,
      costUSD: 2.139,
      canonicalModel: 'claude-sonnet-5',
    },
    'claude-haiku-4-5-20251001': {
      inputTokens: 899,
      outputTokens: 11,
      costUSD: 0.001,
      canonicalModel: 'claude-haiku-4-5',
    },
  },
};

describe('parseTotals', () => {
  it('starts from zero when the issue has no note yet', () => {
    expect(parseTotals(undefined)).toEqual({ runs: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 });
  });

  it('round-trips what formatTotals wrote', () => {
    const totals = { runs: 3, input: 3_612, output: 55_290, cacheWrite: 338_700, cacheRead: 5_520_660, costUsd: 5.1234 };
    expect(parseTotals(`${formatTotals(totals)}\n\nsome prose`)).toEqual(totals);
  });

  it('reads only the marker line, so prose underneath cannot forge a total', () => {
    const totals = { runs: 1, input: 10, output: 20, cacheWrite: 30, cacheRead: 40, costUsd: 0.5 };
    const forged = `${formatTotals(totals)}\n\nA comment saying runs=999 cost=9999.0 in=1 out=1 cw=1 cr=1`;
    expect(parseTotals(forged)).toEqual(totals);
  });

  it('treats a damaged marker as zero rather than NaN', () => {
    expect(parseTotals(`${USAGE_MARKER} runs=abc cost= -->`)).toEqual({
      runs: 0,
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      costUsd: 0,
    });
  });
});

describe('addRun', () => {
  it('sums every model the session used, not just the one that was asked for', () => {
    expect(addRun(parseTotals(undefined), result)).toEqual({
      runs: 1,
      input: 2_103,
      output: 18_441,
      cacheWrite: 112_900,
      cacheRead: 1_840_220,
      costUsd: 2.14,
    });
  });

  it('accumulates across runs, which is the point of one comment instead of many', () => {
    const after = addRun(addRun(parseTotals(undefined), result), result);
    expect(after.runs).toBe(2);
    expect(after.input).toBe(4_206);
    expect(after.costUsd).toBeCloseTo(4.28, 10);
  });

  it('counts a session that reported no usage as a run that happened', () => {
    expect(addRun(parseTotals(undefined), { type: 'result' })).toEqual({
      runs: 1,
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      costUsd: 0,
    });
  });
});

describe('modelsIn', () => {
  it('prefers the canonical name over the dated key', () => {
    expect(modelsIn(result)).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
  });

  it('falls back to the key when there is no canonical name', () => {
    expect(modelsIn({ type: 'result', modelUsage: { 'some-model': {} } })).toEqual(['some-model']);
  });
});

describe('usageNote', () => {
  const totals = { runs: 3, input: 3_612, output: 55_290, cacheWrite: 338_700, cacheRead: 5_520_660, costUsd: 5.1234 };
  const limits = {
    before: { unifiedWindows: { five_hour: { utilization: 0.62 }, seven_day: { utilization: 0.35 } } },
    after: { unifiedWindows: { five_hour: { utilization: 0.74 }, seven_day: { utilization: 0.36 } } },
  };

  it('leads with the marker, so the next run can find and re-read it', () => {
    const note = usageNote(totals, lastRunFrom(result, limits, 'implement', 'merging'));
    expect(note.startsWith(USAGE_MARKER)).toBe(true);
    expect(parseTotals(note)).toEqual(totals);
  });

  it('reports the totals, the outcome and the rate limit the run left behind', () => {
    const note = usageNote(totals, lastRunFrom(result, limits, 'address-review', 'merging'));
    expect(note).toContain('| cache read | 5,520,660 |');
    expect(note).toContain('**3 runs**');
    expect(note).toContain('$5.12');
    expect(note).toContain('`address-review` → `merging` · 23 turns · 4m 12s');
    expect(note).toContain('claude-haiku-4-5, claude-sonnet-5');
    expect(note).toContain('Rate limit over it · 5-hour 62% → 74% · 7-day 35% → 36%');
  });

  it('says the list price is not a bill, because the number invites the opposite reading', () => {
    const note = usageNote(totals, lastRunFrom(result, limits, 'implement', 'merging'));
    expect(note).toMatch(/list-price equivalent/i);
    expect(note).toMatch(/not billed at that rate/i);
  });

  it('leaves the rate limit out rather than inventing one when the CLI reported none', () => {
    const note = usageNote(totals, lastRunFrom(result, { before: undefined, after: undefined }, 'implement', 'blocked'));
    expect(note).not.toContain('Rate limit');
    expect(note).toContain('→ `blocked`');
  });

  it('shows one figure rather than an arrow when rounding makes both ends the same', () => {
    const flat = {
      before: { unifiedWindows: { five_hour: { utilization: 0.7401 }, seven_day: { utilization: 0.36 } } },
      after: { unifiedWindows: { five_hour: { utilization: 0.7404 }, seven_day: { utilization: 0.36 } } },
    };
    const note = usageNote(totals, lastRunFrom(result, flat, 'implement', 'merging'));
    expect(note).toContain('Rate limit over it · 5-hour 74% · 7-day 36%');
  });

  it('still reports the window when only one end of the run was seen', () => {
    const onlyAfter = { before: undefined, after: limits.after };
    expect(usageNote(totals, lastRunFrom(result, onlyAfter, 'implement', 'merging'))).toContain('5-hour 74%');

    const onlyBefore = { before: limits.before, after: undefined };
    expect(usageNote(totals, lastRunFrom(result, onlyBefore, 'implement', 'merging'))).toContain('5-hour 62%');
  });

  it('labels the token column a total, since the table and the last-run line are different numbers', () => {
    const note = usageNote(totals, lastRunFrom(result, limits, 'implement', 'merging'));
    expect(note).toContain('| tokens | total |');
  });

  it('says "1 run" rather than "1 runs"', () => {
    const one = { ...totals, runs: 1 };
    expect(usageNote(one, lastRunFrom(result, limits, 'implement', 'merging'))).toContain('**1 run**');
  });

  it('gives a short run seconds rather than 0m', () => {
    const quick: StreamEvent = { ...result, duration_ms: 42_000 };
    expect(usageNote(totals, lastRunFrom(quick, limits, 'implement', 'failed'))).toContain('· 42s ·');
  });
});
