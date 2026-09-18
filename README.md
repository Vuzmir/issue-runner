# issue-runner

A scheduled GitHub Action that walks a repository's issue queue one issue at a time, and
hands each one to a worker of your choosing - a coding agent, a script, anything that can
read a directory.

Its point is what it does **not** do. The decision about whether there is work is made from
labels, pull request state and check conclusions. A tick with nothing to do costs a handful
of API calls and never starts the worker, so an agent behind it is billed for work and not
for looking.

## Using it

```yaml
name: issue-runner

on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

concurrency:
  group: issue-runner
  cancel-in-progress: false

permissions:
  contents: read
  issues: write
  pull-requests: write
  actions: read # dead-lock detection, and fetching failing CI logs
  checks: read # the check conclusions the loop decides from
  statuses: read # the same answer from integrations that use commit statuses

jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - id: plan
        uses: yvz-dmr/issue-runner@v1
        with:
          mode: claim

      - name: Work on the issue
        if: steps.plan.outputs.decision == 'claimed'
        shell: bash
        env:
          STATE_DIR: ${{ steps.plan.outputs.state-dir }}
        run: |
          # Your worker goes here. For a coding agent, the prompt is one line:
          #   Read $STATE_DIR/PROTOCOL.md and follow it.
          #   The claimed issue is $STATE_DIR/issue.json.
          echo blocked > "$STATE_DIR/next-status"

      - uses: yvz-dmr/issue-runner@v1
        if: always() && steps.plan.outputs.decision == 'claimed'
        with:
          mode: release
          issue: ${{ steps.plan.outputs.issue }}
          job-status: ${{ job.status }}
          state-dir: ${{ steps.plan.outputs.state-dir }}
```

The work step stays in your workflow rather than inside the action. That is deliberate: it
is what keeps the runner indifferent to what the worker actually is.

## The state machine

Every issue the runner cares about carries exactly one `status:` label. Issues with no
`status:` label are backlog and are invisible to it - labelling an issue `status:open` is
the explicit act that admits it into the queue. That doubles as the authorization boundary:
only someone who can label an issue can hand it to the worker.

| label               | meaning                                          | blocks the queue |
| ------------------- | ------------------------------------------------ | ---------------- |
| (none)              | backlog, not admitted                            | no               |
| `status:open`       | queued, the runner may pick it up                | no               |
| `status:processing` | claimed by a run, work in progress               | **yes**          |
| `status:merging`    | work done, a pull request awaits review/merge    | **yes**\*        |
| `status:blocked`    | needs a human decision                           | no               |
| `status:failed`     | last run failed, needs a human before requeueing | no               |
| `status:done`       | finished and merged (issue closed)               | no               |

\* `merging` blocks *other* issues, but the runner may pick that issue's own pull request
back up - see [Following an open pull request](#following-an-open-pull-request).

The labels are created on the first run; nothing has to be set up by hand.

## What one tick does

1. **Bootstrap** - create any missing `status:` label.
2. **Reap stale locks** - for each `status:processing` issue, read the workflow run id from
   its lock comment and ask GitHub whether that run is still alive. A lock held by a dead
   run is released. With no lock comment, the label's age is compared against
   `stale-lock-minutes` (default 120).
3. **Follow the pull requests** - for each `status:merging` issue, read the recorded pull
   request and decide what happens next. See below.
4. **Busy check** - if any open issue is still `status:processing` or `status:merging`, the
   tick reports `busy` and stops. **No worker runs.**
5. **Select** - otherwise take the lowest-numbered `status:open` issue (FIFO).
6. **Claim** - move it to `status:processing` and post a lock comment naming the run.

## Following an open pull request

An issue sits at `status:merging` from the moment a pull request exists until it is merged.
That holds the queue, deliberately - but "held" does not mean "asleep". Every tick the
runner asks GitHub what changed, and **the answer decides whether a worker starts**:

| what the pull request looks like          | what happens                             | worker |
| ----------------------------------------- | ---------------------------------------- | ------ |
| merged                                     | `status:done`, issue closed               | no     |
| closed without merging, or deleted         | `status:blocked`                          | no     |
| draft                                      | wait                                      | no     |
| checks still running                       | wait                                      | no     |
| checks green, nothing new said             | wait for a human to merge                 | no     |
| **checks red**                             | reclaim the issue, `task=fix-checks`      | yes    |
| **an unanswered human comment or review**  | reclaim the issue, `task=address-review`  | yes    |

Whether CI passed is read from check conclusions and commit statuses - never inferred by a
model. Comments authored by bots, and the runner's own marker comments, are filtered out, or
it would answer itself forever.

A follow-up claim reuses `status:processing` and the ordinary lock rather than adding a
state. One consequence is handled explicitly: when a lock is reclaimed, an issue that
already has an open pull request goes back to `status:merging`, not `status:open` -
requeueing it would hand the same work to a worker that knows nothing about the branch, and
a second pull request for one issue is the outcome nobody wants. The same applies to a
cancelled or failed run.

### What stops it looping

A worker that can push is a worker that can push forever, so three limits sit in the way:

- **One attempt per commit.** The marker records the head SHA the runner acted on. If that
  same commit is still red on the next tick, the fix did not work - or nothing was pushed -
  and the issue is parked at `status:blocked`.
- **A cap per pull request** (`max-fix-attempts`, default 3), so push-fail-push-fail cannot
  run all day even as the SHA keeps changing.
- **The watermark moves before the work, not after.** The claim posts the updated marker
  first, so a run that dies cannot make the next tick answer the same comment twice or spend
  the same attempt again.

Human comments are deliberately *not* capped. There is a person in that loop already, and
rate-limiting a reviewer would be the wrong thing to protect against.

The marker comment is where all of this lives:

```
<!-- issue-runner:pr number=42 sha=abc1234 attempt=2 seen=2026-09-18T12:00:00.000Z -->
```

Only the marker line is parsed, so prose underneath it - including anything a person or an
issue body quotes - cannot forge a field.

## The worker contract

The work step runs only when the claim reports `decision == 'claimed'`. Everything the
worker is given sits in one directory, `steps.<id>.outputs.state-dir`:

| file            | what it is                                                                   |
| --------------- | ---------------------------------------------------------------------------- |
| `PROTOCOL.md`   | how to work the issue: the procedure, copied out of the action                |
| `task`          | `implement`, `fix-checks` or `address-review` - the protocol branches on it   |
| `issue.json`    | the claimed issue                                                             |
| `pr.json`       | follow-ups only: number, state, draft, head SHA and branch                    |
| `checks.json`   | follow-ups only: the checks that failed, with their conclusions               |
| `checks.log`    | follow-ups only: the tail of those jobs' logs, bounded                        |
| `comments.json` | follow-ups only: unanswered human comments and reviews                        |

The issue arrives as a file and never as a shell argument, because a title or a body is
input anyone with write access can author.

Before finishing, the worker writes its outcome into that same directory:

| file          | value                                              |
| ------------- | -------------------------------------------------- |
| `next-status` | `open` / `merging` / `blocked` / `done` / `failed` |
| `pr`          | pull request number, with `next-status=merging`     |

The release step runs with `if: always()` and maps the job's outcome onto a label:

- job cancelled -> `status:open`, or `status:merging` when a pull request is already open
- job failed -> `status:failed`, or `status:merging` when a pull request is already open
- job succeeded -> whatever `next-status` says
- job succeeded but wrote no `next-status` -> `status:blocked`, on purpose, so a misbehaving
  worker parks the queue instead of spinning on the same issue every hour

### The protocol, and what it deliberately leaves out

`worker/PROTOCOL.md` is the procedure a coding agent follows. It carries only what is true
in **any** repository: the contract above, the rule that an issue body is data rather than
instruction, when to stop and write `blocked`, branch and pull request conventions, and the
policy that a worker runs the narrowest test slice and never the whole suite.

It carries nothing repository-specific, and that is what makes it portable. Where the work
needs a local answer it defers to the consuming repository's own agent docs - `AGENTS.md` or
`CLAUDE.md`, which a coding agent loads anyway. Those are where a project states its
engineering principles, its language rule, and **how to run a narrow slice of its tests**.
Adopting the runner means writing those, not editing the protocol.

The protocol travels through the state directory rather than through a path in the
workspace, because once this action is consumed by `uses:` its files are not anywhere the
calling workflow could name. So the work step's prompt is the same line everywhere:

```
Read $STATE_DIR/PROTOCOL.md and follow it. The claimed issue is $STATE_DIR/issue.json.
```

## Inputs

| input                | default          | effect                                                          |
| -------------------- | ---------------- | --------------------------------------------------------------- |
| `mode`               | `claim`          | `claim` picks and locks an issue, `release` hands it back        |
| `token`              | `github.token`   | needs `issues: write`, `checks: read`, `actions: read`           |
| `label-prefix`       | `status:`        | prefix for the state labels                                      |
| `stale-lock-minutes` | `120`            | how long a lock with no identifiable run may be held             |
| `max-fix-attempts`   | `3`              | red-CI fix attempts per pull request before parking it           |
| `follow-reviews`     | `true`           | set `false` to stop treating human comments as work              |
| `dry-run`            | `false`          | decide and report, write nothing back to GitHub                  |
| `force-issue`        | -                | claim only: take this issue instead of the next queued one       |
| `issue`              | -                | release only: the issue to release                               |
| `job-status`         | -                | release only: pass `${{ job.status }}`                           |
| `state-dir`          | `$RUNNER_TEMP/…` | the directory the worker exchanges files through                 |

## Outputs

| output      | value                                                        |
| ----------- | ------------------------------------------------------------ |
| `decision`  | `busy` \| `idle` \| `claimed`                                 |
| `issue`     | the claimed issue number, empty unless `claimed`              |
| `title`     | the claimed issue title                                       |
| `task`      | `implement` \| `fix-checks` \| `address-review`               |
| `pull`      | the pull request being worked on, empty for a fresh issue     |
| `state-dir` | the directory the worker reads from and writes back to        |

## Working on the action

```sh
npm ci
npm run all          # typecheck + tests + bundle
```

`dist/index.js` is the bundle the runner executes and **must be committed**; the runner
never installs dependencies. Rebuild it in the same commit as any source change. The stock
Node `.gitignore` excludes `dist` - the un-ignore at the bottom of `.gitignore` is what keeps
this action working, so do not remove it.

`worker/PROTOCOL.md` is read from disk at run time rather than bundled, so editing it needs
no rebuild. It does have to travel with `dist/`, which is why the action resolves it relative
to itself and fails the claim outright if it is missing: an action that locked an issue and
then handed the worker no procedure would strand that issue.

The engine's decision logic is pure and covered by `src/engine.test.ts` against a fake
gateway - add a case there before changing how the queue behaves. `src/worker.test.ts`
covers what the state directory ends up containing.

## Releasing

Consumers pin `@v1`, so that tag moves:

```sh
npm run all
git tag -f v1.<minor>.<patch>
git tag -f v1 && git push origin v1 --force
```
