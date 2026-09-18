import { describe, expect, it } from 'vitest';

import { lineReader, linesFor, parseLine, summarize, type StreamEvent } from './transcript.js';

describe('summarize', () => {
  it('flattens a multi-line string onto one line', () => {
    expect(summarize('fatal: nope\n  and more\n')).toBe('fatal: nope and more');
  });

  it('keeps a stringified tool input on one line, escapes and all', () => {
    // JSON.stringify has already turned the newline into the two characters \ and n, so it
    // is no longer whitespace to collapse - and no longer a line break either, which is the
    // property that actually matters here.
    const line = summarize({ command: 'git status\n--porcelain' });
    expect(line).not.toContain('\n');
    expect(line).toBe('{"command":"git status\\n--porcelain"}');
  });

  it('truncates rather than letting one failing tool result fill the log', () => {
    const summarized = summarize('x'.repeat(5000));
    expect(summarized).toHaveLength(203);
    expect(summarized.endsWith('...')).toBe(true);
  });
});

describe('linesFor', () => {
  it('reports the session the CLI actually started, not the one that was asked for', () => {
    const event: StreamEvent = {
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-5',
      permissionMode: 'bypassPermissions',
      cwd: '/w',
    };
    expect(linesFor(event)).toEqual(['[init] model=claude-sonnet-5 permissions=bypassPermissions cwd=/w']);
  });

  it('keeps assistant text and tool calls, and drops everything else in the same message', () => {
    const event: StreamEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', text: 'private' },
          { type: 'text', text: 'Branching.' },
          { type: 'text', text: '   ' },
          { type: 'tool_use', name: 'Bash', input: { command: 'git switch -c issue/7' } },
        ],
      },
    };
    expect(linesFor(event)).toEqual(['Branching.', '  -> Bash {"command":"git switch -c issue/7"}']);
  });

  it('keeps only the tool results that failed', () => {
    const event: StreamEvent = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: 'fine', is_error: false },
          { type: 'tool_result', content: 'fatal: nope' },
          { type: 'tool_result', content: 'boom', is_error: true },
        ],
      },
    };
    expect(linesFor(event)).toEqual(['  !! boom']);
  });

  it('closes with what the run cost', () => {
    const event: StreamEvent = {
      type: 'result',
      subtype: 'success',
      num_turns: 12,
      duration_ms: 95_400,
      total_cost_usd: 1.2345,
    };
    expect(linesFor(event)).toEqual(['[result] success turns=12 95s $1.23']);
  });

  it('says nothing about events that are not worth a line', () => {
    expect(linesFor({ type: 'rate_limit_event' })).toEqual([]);
    expect(linesFor({ type: 'system', subtype: 'compact_boundary' })).toEqual([]);
  });
});

describe('parseLine', () => {
  it('reads an event', () => {
    expect(parseLine('{"type":"result","num_turns":3}')).toEqual({ type: 'result', num_turns: 3 });
  });

  it('says nothing for a line the CLI printed plainly, so the caller can keep it', () => {
    expect(parseLine('Warning: something the CLI printed plainly')).toBeUndefined();
  });

  it('rejects valid JSON that is not an object, which would read as an event with no fields', () => {
    expect(parseLine('42')).toBeUndefined();
    expect(parseLine('null')).toBeUndefined();
    expect(parseLine('"a string"')).toBeUndefined();
  });
});

describe('lineReader', () => {
  it('reassembles a line that a chunk boundary split', () => {
    const seen: string[] = [];
    const feed = lineReader((line) => seen.push(line));

    feed('{"type":"assi');
    expect(seen).toEqual([]);

    feed('stant"}\n{"type":"result"}\n');
    expect(seen).toEqual(['{"type":"assistant"}', '{"type":"result"}']);
  });

  it('holds a trailing line back until its newline arrives', () => {
    const seen: string[] = [];
    const feed = lineReader((line) => seen.push(line));

    feed('one\ntwo');
    expect(seen).toEqual(['one']);

    feed('\n');
    expect(seen).toEqual(['one', 'two']);
  });
});
