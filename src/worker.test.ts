import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IssueView } from './gateway.js';
import { PROTOCOL_NAME, publishWorkerInput } from './worker.js';

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
});
