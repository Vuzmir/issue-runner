import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommentView, IssueView } from './gateway.js';
import { PROTOCOL_NAME, WAIT_SCRIPT_NAME, publishWorkerInput } from './worker.js';

const issue: IssueView = {
  number: 7,
  title: 'Something to do',
  labels: ['status:processing'],
  updatedAt: '2026-09-18T12:00:00Z',
  body: 'The body.',
  url: 'https://github.test/issues/7',
  author: 'someone',
};

let root: string;
let stateDir: string;
let protocol: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-runner-test-'));
  stateDir = path.join(root, 'state');
  protocol = path.join(root, 'PROTOCOL.md');
  fs.writeFileSync(protocol, '# Worker protocol\n');
  fs.writeFileSync(path.join(root, WAIT_SCRIPT_NAME), '#!/bin/sh\n"$@"\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('publishWorkerInput', () => {
  it('creates the state directory when it does not exist yet', () => {
    publishWorkerInput(stateDir, issue, protocol);
    expect(fs.existsSync(stateDir)).toBe(true);
  });

  it('writes the issue as json rather than passing it as an argument', () => {
    publishWorkerInput(stateDir, issue, protocol);
    const written: IssueView = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'issue.json'), 'utf8'),
    );
    expect(written).toEqual(issue);
  });

  it('copies the protocol in beside the issue, so the worker needs no path of its own', () => {
    publishWorkerInput(stateDir, issue, protocol);
    expect(fs.readFileSync(path.join(stateDir, PROTOCOL_NAME), 'utf8')).toBe(
      '# Worker protocol\n',
    );
  });

  it('fails loudly when the protocol is missing instead of claiming an issue nothing can work', () => {
    expect(() => publishWorkerInput(stateDir, issue, path.join(root, 'gone.md'))).toThrow(
      /protocol is missing/,
    );
  });

  it('copies the wait-for script in beside the protocol, executable', () => {
    publishWorkerInput(stateDir, issue, protocol);
    const written = path.join(stateDir, WAIT_SCRIPT_NAME);
    expect(fs.readFileSync(written, 'utf8')).toBe('#!/bin/sh\n"$@"\n');
    // Windows has no execute bit to assert on - same carve-out install.ts takes for the CLI
    // binary itself.
    if (process.platform !== 'win32') expect(fs.statSync(written).mode & 0o111).not.toBe(0);
  });

  it('fails loudly when the wait-for script is missing, same as a missing protocol', () => {
    fs.rmSync(path.join(root, WAIT_SCRIPT_NAME));
    expect(() => publishWorkerInput(stateDir, issue, protocol)).toThrow(/wait-for script is missing/);
  });

  it('writes an empty comment thread when none is handed in', () => {
    publishWorkerInput(stateDir, issue, protocol);
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'issue-comments.json'), 'utf8'))).toEqual(
      [],
    );
  });

  it('carries the issue thread so a reopened issue is read as a continuation, not restarted', () => {
    const priorComments: CommentView[] = [
      {
        kind: 'comment',
        author: 'someone',
        createdAt: '2026-09-19T09:00:00Z',
        body: 'just clean all the dead code',
        url: 'https://github.test/issues/7#c1',
      },
    ];
    publishWorkerInput(stateDir, issue, protocol, priorComments);
    const written: CommentView[] = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'issue-comments.json'), 'utf8'),
    );
    expect(written).toEqual(priorComments);
  });
});
